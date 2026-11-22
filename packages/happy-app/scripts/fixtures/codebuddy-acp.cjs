#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

const cwd = process.cwd();
const probe = process.argv.includes('--no-session-persistence');
const statePath = join(cwd, '.codebuddy-fixture-session');
const state = !probe && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {
    id: 'fixture-codebuddy-session', prompts: 0, mode: 'default', model: 'fixture-default',
};
const configOptions = () => [{
    type: 'select', category: 'model', id: 'model', name: 'Model', currentValue: state.model,
    options: [{ value: 'fixture-default', name: 'Fixture default' }, { value: 'fixture-model', name: 'Fixture model' }],
}, {
    type: 'select', category: 'mode', id: 'mode', name: 'Permission Mode', currentValue: state.mode,
    options: [{ value: 'default', name: 'Always Ask' }, { value: 'bypassPermissions', name: 'Bypass Permissions' }],
}];
const observe = (event, fields) => appendFileSync(process.env.HAPPY_CODEBUDDY_FIXTURE_LOG, JSON.stringify({ event, cwd, probe, ...fields }) + '\n');
const write = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\n');
const reply = (id, result) => write({ id, result });
const update = (sessionUpdate) => write({ method: 'session/update', params: { sessionId: state.id, update: sessionUpdate } });
const chunk = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const io = createInterface({ input: process.stdin });
let pending;
let toolPrompt;
let lateOutput = false;
const toolUpdate = (toolCallId, fields = {}) => update({ sessionUpdate: 'tool_call_update', toolCallId, ...fields });

function bashCalls() {
    const first = 'fixture-bash-a';
    const second = 'fixture-bash-b';
    const meta = { 'codebuddy.ai/toolName': 'Bash' };
    const command = `printf '%s\\n' 'FIXTURE_LONG_COMMAND${'1234567890'.repeat(8)}'\nprintf '%s\\n' 'second line'`;
    update({ sessionUpdate: 'tool_call', toolCallId: first, status: 'in_progress', kind: 'other', title: 'Bash', rawInput: {}, _meta: meta });
    toolUpdate(first, { rawInput: { command: '' }, content: [{ type: 'content', content: { type: 'text', text: 'argument JSON fragment' } }], _meta: meta });
    update({ sessionUpdate: 'tool_call', toolCallId: second, kind: 'execute', status: 'pending', title: 'Bash', rawInput: { command: 'false' }, _meta: meta });
    update({ sessionUpdate: 'tool_call', toolCallId: first, kind: 'execute', status: 'pending', title: 'Fixture description',
        rawInput: { command, cwd, description: 'Fixture probe' }, content: [{ type: 'content', content: { type: 'text', text: 'Fixture probe' } }],
        _meta: { ...meta, 'codebuddy.ai/toolArgumentsComplete': true },
    });
    toolUpdate(first, { rawOutput: { stdout: 'FIXTURE_FIRST_OUTPUT\n' } });
    toolUpdate(second, { status: 'failed', rawOutput: { stderr: 'FIXTURE_FAILURE_OUTPUT\n', exitCode: 7 } });
}

function nonBashCalls(prefix = 'fixture') {
    const read = `${prefix}-read`;
    const grep = `${prefix}-grep`;
    const edit = `${prefix}-edit`;
    const mcp = `${prefix}-mcp`;
    const custom = `${prefix}-custom`;
    const file = join(cwd, 'src/example.ts');
    update({ sessionUpdate: 'tool_call', toolCallId: read, kind: 'read', title: 'Read', status: 'in_progress', rawInput: { file_path: join(cwd, 'README.md') }, _meta: { 'codebuddy.ai/toolName': 'Read' } });
    toolUpdate(read, { status: 'completed', rawOutput: [{ type: 'text', text: 'FIXTURE_READ_OUTPUT' }] });
    update({ sessionUpdate: 'tool_call', toolCallId: grep, kind: 'search', title: 'Grep', status: 'in_progress', rawInput: { pattern: 'fixture-query', path: cwd, include: '*.ts' }, _meta: { 'codebuddy.ai/toolName': 'Grep' } });
    toolUpdate(grep, { status: 'completed', rawOutput: 'FIXTURE_GREP_OUTPUT' });
    update({ sessionUpdate: 'tool_call', toolCallId: edit, kind: 'edit', title: 'Edit', status: 'in_progress', rawInput: { file_path: file, old_string: 'before fixture', new_string: 'after fixture' }, _meta: { 'codebuddy.ai/toolName': 'Edit' } });
    toolUpdate(edit, { status: 'completed', content: [{ type: 'diff', path: file, oldText: 'before fixture', newText: 'after fixture' }] });
    update({ sessionUpdate: 'tool_call', toolCallId: mcp, kind: 'other', title: 'mcp__fixture__lookup', status: 'in_progress', rawInput: { query: 'mcp-query', scope: 'workspace' }, _meta: { 'codebuddy.ai/toolName': 'mcp__fixture__lookup' } });
    toolUpdate(mcp, { status: 'completed', _meta: { 'codebuddy.ai/rawResponse': { is_error: false, content: [{ type: 'text', text: 'FIXTURE_MCP_OUTPUT' }] } } });
    update({ sessionUpdate: 'tool_call', toolCallId: custom, kind: 'other', title: 'CustomTool', status: 'in_progress', rawInput: { target: 'preview' }, _meta: { 'codebuddy.ai/toolName': 'CustomTool' } });
    toolUpdate(custom, { status: 'failed', _meta: { 'codebuddy.ai/rawResponse': { is_error: true, error: 'FIXTURE_CUSTOM_FAILURE token=fixture123' } } });
}

observe('start', { args: process.argv.slice(2) });
io.on('line', (line) => {
    const { id, method, params, result } = JSON.parse(line);
    switch (method) {
        case 'initialize':
            reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
            break;
        case 'session/new':
            observe('new', { requestedCwd: params.cwd });
            reply(id, { sessionId: state.id, configOptions: configOptions() });
            break;
        case 'session/set_config_option': {
            const option = configOptions().find(entry => entry.id === params.configId);
            if (!option?.options.some(entry => entry.value === params.value)) {
                write({ id, error: { code: -32602, message: 'Unsupported fixture option' } });
                break;
            }
            state[option.id] = params.value;
            observe('configure', { configId: option.id, value: params.value });
            reply(id, { configOptions: configOptions() });
            break;
        }
        case 'session/load':
            observe('load', { requestedCwd: params.cwd, sessionId: params.sessionId });
            if (params.sessionId !== state.id || !existsSync(statePath)) {
                write({ id, error: { code: -32602, message: 'Saved fixture session unavailable' } });
                return;
            }
            chunk('Replayed provider history');
            reply(id, { configOptions: configOptions() });
            break;
        case 'session/prompt': {
            const text = params.prompt[0].text;
            state.prompts++;
            if (!probe) writeFileSync(statePath, JSON.stringify(state));
            observe('prompt', { text, sessionId: params.sessionId, count: state.prompts, mode: state.mode, model: state.model });
            if (text.includes('ACP_FAIL')) {
                reply(id, { stopReason: 'refusal', _meta: {
                    'codebuddy.ai/outcome': 'FAILED_MODEL_REQUEST',
                    'codebuddy.ai/errorMessage': '{"code":-32000,"message":"Authentication required","data":{"statusCode":401}}',
                } });
            } else if (text.includes('ACP_CANCEL') || text.includes('ACP_FIRST')) {
                pending = id;
                chunk(text.includes('ACP_FIRST') ? 'Streaming fixture' : 'Fixture waiting for cancellation');
            } else if (text.includes('ACP_PERMISSION')) {
                pending = id;
                const toolCall = { toolCallId: 'fixture-permission', kind: 'execute', title: 'Fixture tool', rawInput: { command: 'echo fixture' } };
                update({ sessionUpdate: 'tool_call', ...toolCall, status: 'pending' });
                write({ id: 'permission', method: 'session/request_permission', params: { sessionId: state.id, toolCall, options: [
                    { optionId: 'deny-id', kind: 'reject_once', name: '拒绝' },
                    { optionId: 'allow-id', kind: 'allow_once', name: '允许' },
                ] } });
            } else if (text.includes('ACP_PARTIAL')) {
                nonBashCalls('fixture-partial');
                chunk('Partial content preserved');
                reply(id, { stopReason: 'end_turn', _meta: {
                    'codebuddy.ai/outcome': 'PARTIAL_SUCCESS',
                    'codebuddy.ai/errorMessage': 'two reads finished; one tool failed; token=fixture123',
                } });
            } else if (text.includes('ACP_TOOLS')) {
                toolPrompt = id;
                bashCalls();
                nonBashCalls();
            } else {
                chunk('Fixture reply ' + state.prompts);
                reply(id, { stopReason: 'end_turn' });
            }
            break;
        }
        case 'session/cancel':
            observe('cancel', { sessionId: params.sessionId });
            if (pending !== undefined) reply(pending, { stopReason: 'cancelled' });
            pending = undefined;
            break;
        default:
            if (id === 'permission') {
                observe('permission', { outcome: result.outcome });
                update({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-permission', status: 'completed' });
                chunk('Fixture permission handled');
                reply(pending, { stopReason: 'end_turn' });
                pending = undefined;
            }
    }
});

// Give the browser time to prove that the first chunk is visible before
// sending the native completion marker. The test releases it explicitly.
const gate = setInterval(() => {
    if (toolPrompt !== undefined && existsSync(process.env.HAPPY_CODEBUDDY_FIXTURE_LOG + '.tools-finish')) {
        toolUpdate('fixture-bash-a', { status: 'completed', _meta: { 'codebuddy.ai/rawResponse': { exitCode: 0 } } });
        chunk('Fixture tools finished');
        reply(toolPrompt, { stopReason: 'end_turn' });
        toolPrompt = undefined;
        lateOutput = true;
    }
    if (lateOutput && existsSync(process.env.HAPPY_CODEBUDDY_FIXTURE_LOG + '.tools-late')) {
        const fields = { rawOutput: { stdout: 'FIXTURE_FIRST_OUTPUT\nFIXTURE_LATE_OUTPUT\n' } };
        toolUpdate('fixture-bash-a', fields);
        toolUpdate('fixture-bash-a', fields);
        lateOutput = false;
    }
    if (pending === undefined || !existsSync(process.env.HAPPY_CODEBUDDY_FIXTURE_LOG + '.finish')) return;
    if (state.prompts !== 1) return;
    chunk(' reply');
    reply(pending, { stopReason: 'end_turn' });
    pending = undefined;
}, 50);
io.on('close', () => clearInterval(gate));
