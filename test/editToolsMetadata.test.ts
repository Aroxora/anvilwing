import { createEditTools } from '../src/tools/editTools.js';

describe('Edit tool metadata', () => {
  it('exposes expected schema defaults and requirements', () => {
    const tools = createEditTools(process.cwd());
    const edit = tools.find((tool) => tool.name === 'Edit');
    expect(edit).toBeDefined();

    const params = edit?.parameters as any;
    expect(params?.type).toBe('object');

    // Required args should not force new_string (it defaults to empty string)
    expect(params?.required).toEqual(['file_path', 'old_string']);

    const props = params?.properties ?? {};
    expect(props.new_string?.default).toBe('');
    expect(props.new_string?.description).toMatch(/Defaults to ""/);
    expect(params?.additionalProperties).toBe(false);
  });
});
