import { createTodoTools, getCurrentTodos, clearCurrentTodos } from '../src/tools/todoTools.js';

describe('TodoRead (Claude Code parity)', () => {
  let readHandler: (args: Record<string, unknown>) => Promise<string>;
  let writeHandler: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    clearCurrentTodos();
    const tools = createTodoTools();
    const readTool = tools.find((t) => t.name === 'TodoRead');
    const writeTool = tools.find((t) => t.name === 'TodoWrite');
    if (!readTool) throw new Error('TodoRead tool not found — add it to createTodoTools()');
    if (!writeTool) throw new Error('TodoWrite tool not found');
    readHandler = readTool.handler as (args: Record<string, unknown>) => Promise<string>;
    writeHandler = writeTool.handler as (args: Record<string, unknown>) => Promise<string>;
  });

  it('createTodoTools() exposes both TodoRead and TodoWrite', () => {
    const names = createTodoTools().map((t) => t.name);
    expect(names).toContain('TodoRead');
    expect(names).toContain('TodoWrite');
  });

  it('returns empty-state message when no todos have been written', async () => {
    const out = await readHandler({});
    expect(out).toMatch(/No todos/i);
  });

  it('returns current todos as JSON after a write', async () => {
    await writeHandler({
      todos: [
        { content: 'Step one', status: 'completed' },
        { content: 'Step two', status: 'in_progress' },
        { content: 'Step three', status: 'pending' },
      ],
    });
    const out = await readHandler({});
    const parsed = JSON.parse(out) as Array<{ content: string; status: string }>;
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.content).toBe('Step one');
    expect(parsed[0]?.status).toBe('completed');
    expect(parsed[1]?.status).toBe('in_progress');
    expect(parsed[2]?.status).toBe('pending');
  });

  it('does NOT modify the list (read is non-destructive)', async () => {
    await writeHandler({ todos: [{ content: 'Only task', status: 'pending' }] });
    await readHandler({});
    expect(getCurrentTodos()).toHaveLength(1);
    expect(getCurrentTodos()[0]?.content).toBe('Only task');
  });

  it('reflects the latest write after multiple writes', async () => {
    await writeHandler({ todos: [{ content: 'First', status: 'pending' }] });
    await writeHandler({ todos: [{ content: 'Second', status: 'in_progress' }] });
    const out = await readHandler({});
    const parsed = JSON.parse(out) as Array<{ content: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.content).toBe('Second');
  });

  it('reads empty list after explicit clear write', async () => {
    await writeHandler({ todos: [{ content: 'Task', status: 'pending' }] });
    await writeHandler({ todos: [] });
    const out = await readHandler({});
    expect(out).toMatch(/No todos/i);
  });

  it('TodoRead schema has empty parameters (no required fields)', () => {
    const tools = createTodoTools();
    const tool = tools.find((t) => t.name === 'TodoRead');
    expect(tool?.parameters.required).toEqual([]);
    expect(Object.keys(tool?.parameters.properties ?? {})).toHaveLength(0);
  });
});

describe('TodoWrite', () => {
  let handler: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    clearCurrentTodos();
    const tool = createTodoTools().find((t) => t.name === 'TodoWrite');
    if (!tool) throw new Error('TodoWrite tool not found');
    handler = tool.handler as (args: Record<string, unknown>) => Promise<string>;
  });

  it('replaces the list each call (state is total, not append)', async () => {
    await handler({
      todos: [
        { content: 'Read auth code', status: 'completed' },
        { content: 'Fix race condition', status: 'in_progress' },
        { content: 'Write tests', status: 'pending' },
      ],
    });
    expect(getCurrentTodos().length).toBe(3);
    expect(getCurrentTodos()[1].status).toBe('in_progress');

    // Replace with a single item — old list must be gone.
    await handler({
      todos: [{ content: 'Only this one', status: 'pending' }],
    });
    expect(getCurrentTodos().length).toBe(1);
    expect(getCurrentTodos()[0].content).toBe('Only this one');
  });

  it('renders a plan with status markers', async () => {
    const out = await handler({
      todos: [
        { content: 'Task one', status: 'completed' },
        { content: 'Task two', status: 'in_progress', activeForm: 'Working on task two' },
        { content: 'Task three', status: 'pending' },
      ],
    });
    expect(out).toContain('Task one');
    // While in_progress, render uses activeForm if provided.
    expect(out).toContain('Working on task two');
    expect(out).toContain('Task three');
  });

  it('skips entries without content', async () => {
    await handler({
      todos: [
        { content: '', status: 'pending' },
        { status: 'pending' },
        { content: 'Real task', status: 'pending' },
      ],
    });
    expect(getCurrentTodos().length).toBe(1);
    expect(getCurrentTodos()[0].content).toBe('Real task');
  });

  it('coerces unknown status to pending', async () => {
    await handler({
      todos: [
        { content: 'Task A', status: 'wontfix' },
        { content: 'Task B', status: 'in-progress' }, // hyphenated form
      ],
    });
    expect(getCurrentTodos()[0].status).toBe('pending');
    expect(getCurrentTodos()[1].status).toBe('in_progress');
  });

  it('warns when more than one task is in_progress', async () => {
    const out = await handler({
      todos: [
        { content: 'Task A', status: 'in_progress' },
        { content: 'Task B', status: 'in_progress' },
        { content: 'Task C', status: 'pending' },
      ],
    });
    expect(out).toMatch(/2 tasks are in_progress/);
  });

  it('handles empty list (clearing the plan)', async () => {
    await handler({ todos: [{ content: 'Foo', status: 'pending' }] });
    expect(getCurrentTodos().length).toBe(1);
    await handler({ todos: [] });
    expect(getCurrentTodos().length).toBe(0);
  });

  it('rejects non-array todos input gracefully', async () => {
    await handler({ todos: 'not an array' as unknown as object });
    expect(getCurrentTodos().length).toBe(0);
  });
});
