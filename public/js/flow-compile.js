// Compiles a flow-canvas graph into a tree of micro-flow Workflows.
//
// Starting at the trigger, each node becomes one step:
// - action nodes are Steps whose callable runs the node and stores its output
//   in ctx.out (keyed by step id); the next node's inputFn reads it there.
// - one successor is appended to the same Workflow. Several successors (fan-out)
//   each become a Step whose callable is a nested Workflow, run in port order.
// - If → ConditionalStep, Switch → SwitchStep + Cases, Loop/Repeat → LoopStep;
//   each of their branches is a nested body Workflow.
// - Wait, Stop If and Skip Next If pass their input straight through.
// A node reached by several paths compiles once per path; `steps` maps every
// compiled step id back to its node (and the wire that led to it).
import {
  Workflow,
  Step,
  LoopStep,
  ConditionalStep,
  SwitchStep,
  Case,
  DelayStep,
  FlowControlStep,
} from 'micro-flow';
import { NODE_TYPES, getPath, conditionValue, StopError } from './flow-nodes.js';

export class GraphError extends Error {
  constructor(message, node_id = null) {
    super(message);
    this.node_id = node_id;
  }
}

// Checks a graph before compiling. Returns { trigger, reachable }.
export function validate(graph) {
  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) throw new GraphError('Add a Manual Trigger: every flow starts at one.');
  if (triggers.length > 1) throw new GraphError('Only one Manual Trigger is allowed.', triggers[1].id);

  const reachable = new Set();
  const visit = (id, stack) => {
    if (stack.includes(id)) throw new GraphError('This flow has a cycle. Use a Loop or Repeat node to run things more than once.', id);
    reachable.add(id);
    for (const edge of graph.edges.filter((e) => e.from === id)) visit(edge.to, [...stack, id]);
  };
  visit(triggers[0].id, []);
  return { trigger: triggers[0], reachable };
}

// ctx (created per run by the page): { out, last, item, trigger, stopped,
// iteration_failed, display(card), record(node_id, input, output), sleep(ms) }.
export function compileGraph(graph, ctx, { exit_on_error = true } = {}) {
  const { trigger } = validate(graph);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps = new Map();      // step id → { node_id, edge_id, step }
  const bodies = new Map();     // body workflow id → { node_id, port, workflow }
  const children = new Map();   // step id → [{ label, workflow }] (for the tree view)
  const workflows = new Set();

  const successors = (node_id, port) =>
    graph.edges.filter((e) => e.from === node_id && e.port === port);

  const stepOptions = (node, container) => {
    const timeout = node.settings?.timeout_ms;
    return {
      name: node.name,
      max_retries: Math.max(0, Number(node.settings?.retries) || 0),
      // Containers default to no timeout: their branches may make network calls.
      max_timeout_ms: timeout ? Number(timeout) : container ? null : 30000,
    };
  };

  function makeWorkflow(name, wf_steps) {
    const wf = new Workflow({ name, exit_on_error, steps: wf_steps });
    workflows.add(wf);
    return wf;
  }

  function body(node, port, label, edges, inputFn, stack) {
    const wf = makeWorkflow(`${node.name} › ${label}`, continuation(edges, inputFn, stack));
    bodies.set(wf.id, { node_id: node.id, port, workflow: wf });
    return wf;
  }

  function continuation(edges, inputFn, stack) {
    if (edges.length === 0) return [];
    if (edges.length === 1) return chain(edges[0], inputFn, stack);
    // Fan-out: every branch is its own Workflow, run one after another.
    return edges.map((edge) => {
      const target = nodes.get(edge.to);
      const wf = makeWorkflow(`branch → ${target.name}`, chain(edge, inputFn, stack));
      const step = new Step({ name: `branch → ${target.name}`, callable: wf, max_timeout_ms: null });
      children.set(step.id, [{ label: 'callable', workflow: wf }]);
      return step;
    });
  }

  const checkStop = () => {
    if (ctx.stopped) throw new StopError('stopped by user');
  };

  function condition(node, inputFn) {
    const { path, op, value } = node.config;
    return {
      subject: () => getPath(inputFn(), path, ctx),
      operator: op,
      value: conditionValue(op, value, inputFn, ctx),
    };
  }

  // A loop pass is a body Workflow: a hidden step that makes the item the
  // pass's input, the "each" branch, then a hidden step that keeps the pass's
  // last output. A Stop If that breaks the pass skips the collect step, so the
  // item is filtered out.
  function loopBody(node, itemFn, edges, collector, stack) {
    const item = new Step({
      name: `· ${node.name} item`,
      callable: function loopItem() {
        checkStop();
        ctx.item = itemFn();
        ctx.last = ctx.item;
        ctx.iteration_failed = false;
        ctx.out.set(this.id, ctx.item);
      },
    });
    const collect = new Step({
      name: `· ${node.name} collect`,
      callable: function loopCollect() {
        if (!ctx.iteration_failed) collector.push(ctx.last);
      },
    });
    const wf = makeWorkflow(`${node.name} › each`, [
      item,
      ...continuation(edges, () => ctx.out.get(item.id), stack),
      collect,
    ]);
    bodies.set(wf.id, { node_id: node.id, port: 'each', workflow: wf });
    return wf;
  }

  function chain(edge, inputFn, stack) {
    const node = nodes.get(edge.to);
    if (stack.includes(node.id)) throw new GraphError('This flow has a cycle.', node.id);
    const next_stack = [...stack, node.id];
    const def = NODE_TYPES[node.type];
    const register = (step) => {
      steps.set(step.id, { node_id: node.id, edge_id: edge.id, step });
      return step;
    };
    const after = (port, fn = inputFn) => continuation(successors(node.id, port), fn, next_stack);

    switch (def.kind) {
      case 'action': {
        const step = register(new Step({
          ...stepOptions(node, false),
          callable: async function runNode() {
            checkStop();
            ctx.out.delete(this.id);
            const input = node.type === 'trigger' ? undefined : inputFn();
            if (input === undefined && node.type !== 'trigger') {
              throw new Error('no input: the step before this one failed or was skipped');
            }
            const output = await def.run(input, node.config, ctx, this);
            checkStop();
            ctx.out.set(this.id, output);
            ctx.last = output;
            ctx.record(node.id, input, output);
            // Keep the step's own result small: event payloads embed it.
            return { node: node.name, output_type: Array.isArray(output) ? 'array' : typeof output };
          },
        }));
        return [step, ...after('main', () => ctx.out.get(step.id))];
      }

      case 'delay': {
        const step = register(new DelayStep({
          name: node.name,
          relative_delay_ms: Math.max(0, Number(node.config.ms) || 0),
        }));
        return [step, ...after('main')];
      }

      case 'break':
      case 'skip': {
        const step = register(new FlowControlStep({
          ...stepOptions(node, false),
          flow_control_type: def.kind,
          conditional: condition(node, inputFn),
        }));
        return [step, ...after('main')];
      }

      case 'if': {
        const true_wf = body(node, 'true', 'true', successors(node.id, 'true'), inputFn, next_stack);
        const false_wf = body(node, 'false', 'false', successors(node.id, 'false'), inputFn, next_stack);
        const step = register(new ConditionalStep({
          ...stepOptions(node, true),
          conditional: condition(node, inputFn),
          true_callable: true_wf,
          false_callable: false_wf,
        }));
        children.set(step.id, [{ label: 'true', workflow: true_wf }, { label: 'false', workflow: false_wf }]);
        return [step];
      }

      case 'switch': {
        const kids = [];
        const cases = (node.config.cases ?? []).map((kase, i) => {
          const port = `case-${i}`;
          const wf = body(node, port, `case ${kase.value}`, successors(node.id, port), inputFn, next_stack);
          const case_step = new Case({
            name: `${node.name} case ${i + 1}`,
            conditional: { subject: null, operator: kase.op, value: conditionValue(kase.op, kase.value, inputFn, ctx) },
            callable: wf,
            max_timeout_ms: null,
          });
          steps.set(case_step.id, { node_id: node.id, edge_id: null, step: case_step, port });
          kids.push({ label: `Case ${kase.op} ${kase.value ?? ''}`, workflow: wf });
          return case_step;
        });
        const default_wf = body(node, 'default', 'default', successors(node.id, 'default'), inputFn, next_stack);
        kids.push({ label: 'default', workflow: default_wf });
        const step = register(new SwitchStep({
          ...stepOptions(node, true),
          // A Case throws if the subject is null or undefined, so a missing
          // value is compared as ''.
          subject: () => getPath(inputFn(), node.config.path, ctx) ?? '',
          cases,
          default_callable: default_wf,
        }));
        children.set(step.id, kids);
        return [step];
      }

      case 'loop':
      case 'repeat': {
        const collector = [];
        let loop_step = null;
        let outer_item = null;
        const itemFn = def.kind === 'loop'
          ? () => loop_step.current_item
          : () => {
            const input = inputFn();
            const base = input && typeof input === 'object' && !Array.isArray(input) ? input : { value: input };
            return { ...base, index: loop_step.results.length };
          };
        const wf = loopBody(node, itemFn, successors(node.id, 'each'), collector, next_stack);

        if (def.kind === 'loop') {
          loop_step = new LoopStep({
            ...stepOptions(node, true),
            loop_type: 'for_each',
            // A function iterable is called when the loop starts, so it reads
            // whatever the step before produced on this run.
            iterable: function loopItems() {
              const value = getPath(inputFn(), node.config.path, ctx);
              if (Array.isArray(value)) return value;
              if (value && typeof value === 'object') return Object.entries(value).map(([key, v]) => ({ key, value: v }));
              return value === undefined ? [] : [value];
            },
            callable: wf,
          });
        } else {
          loop_step = new LoopStep({
            ...stepOptions(node, true),
            loop_type: 'for',
            iterations: Math.max(0, Math.min(500, Number(node.config.times) || 0)),
            max_iterations: 500,
            callable: wf,
          });
        }
        register(loop_step);
        children.set(loop_step.id, [{ label: 'each', workflow: wf }]);

        // Hidden steps around the loop: one resets the results and remembers
        // the outer $item, the other hands the results to the "done" branch.
        const reset = new Step({
          name: `· ${node.name} start`,
          callable: function loopStart() {
            checkStop();
            outer_item = ctx.item;
            collector.length = 0;
          },
        });
        const done = new Step({
          name: `· ${node.name} done`,
          callable: function loopDone() {
            ctx.item = outer_item;
            ctx.out.set(this.id, [...collector]);
            ctx.last = ctx.out.get(this.id);
            ctx.record(node.id, inputFn(), ctx.last);
          },
        });
        return [reset, loop_step, done, ...after('done', () => ctx.out.get(done.id))];
      }

      default:
        throw new GraphError(`Unknown node type "${node.type}".`, node.id);
    }
  }

  const root = makeWorkflow(graph.name || 'flow-canvas', chain({ id: null, to: trigger.id }, () => undefined, []));
  return { root, steps, bodies, children, workflows };
}
