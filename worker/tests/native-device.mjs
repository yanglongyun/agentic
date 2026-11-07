// Run against a local Worker and a real Rust --headless --no-browser device.
import WebSocket from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-native-acceptance-'));
const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT || 9508}/ws?device=web`);
const messages = [];
ws.on('message', (raw) => messages.push(JSON.parse(raw)));
const wait = async (match, label) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        const value = messages.find(match);
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`等待超时：${label}`);
};
const send = (type, data, to = 'hub') => ws.send(JSON.stringify({ type, data, to }));
let seq = 0;
const request = async (op, args = {}) => {
    const reqId = `native-${seq++}`;
    send('agent.request', { reqId, op, args });
    const result = await wait((m) => m.type === 'agent.result' && m.data.reqId === reqId, op);
    assert.equal(result.data.ok, true, JSON.stringify(result));
    return result.data.data;
};
const rounds = [];
const model = http.createServer((req, res) => {
    req.resume();
    const output = rounds.shift();
    if (!output) { res.writeHead(500).end('No fixture'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const response = { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`);
});
try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    send('auth.submit', { password: process.env.ACCESS_PASSWORD || 'e2e-pass' });
    await wait((m) => m.type === 'auth.state' && m.data.authenticated, 'login');
    const listing = await wait((m) => m.type === 'connection.devices' && m.data.devices.some((d) => d.online), 'devices');
    const device = listing.data.devices.find((d) => d.online);
    console.log('✓ 真实 Rust 设备通过 Worker 登记');
    const target = `device:${device.id}`;
    const fsCall = async (type, data, expected = 'fs.result') => {
        const reqId = `native-fs-${seq++}`;
        send(type, { ...data, reqId }, target);
        const result = await wait((m) => m.type === expected && m.data.reqId === reqId, type);
        assert.notEqual(result.data.ok, false, JSON.stringify(result));
        assert.equal(result.meta.deviceId, device.id);
        return result;
    };
    await fsCall('fs.home', {});
    const upload = path.join(dir, 'upload.txt');
    const reqId = `upload-${seq++}`;
    send('fs.upload.start', { reqId, path: upload, size: 13, overwrite: false }, target);
    await wait((m) => m.type === 'fs.result' && m.data.reqId === reqId && m.data.ready, 'upload ready');
    send('fs.upload.chunk', { reqId, seq: 0, data: Buffer.from('rust-uploaded').toString('base64'), eof: true }, target);
    await wait((m) => m.type === 'fs.result' && m.data.reqId === reqId && m.data.completed, 'upload complete');
    assert.equal(fs.readFileSync(upload, 'utf8'), 'rust-uploaded');
    const read = await fsCall('fs.read', { path: upload }, 'fs.read.chunk');
    assert.equal(Buffer.from(read.data.data, 'base64').toString(), 'rust-uploaded');
    console.log('✓ 网页 → Worker → Rust 文件上传与读取');
    const status = await fsCall('status.request', {}, 'status.result');
    assert.ok(status.data.mem.total > 0 && status.data.cpu.count > 0);
    console.log('✓ 真实系统状态');
    send('terminal.list', {}, target);
    const terminals = await wait((m) => m.type === 'terminal.list' && m.meta?.deviceId === device.id, 'terminal list');
    send('data.input', { terminalId: terminals.data.activeTerminalId, input: "printf 'native-pty-acceptance\\n'\r" }, target);
    await wait((m) => m.type === 'data.output' && m.data.output.includes('native-pty-acceptance'), 'terminal output');
    console.log('✓ 网页 → Worker → Rust PTY 终端');
    await new Promise((resolve) => model.listen(9612, '127.0.0.1', resolve));
    await request('config.put', { responsesUrl: 'http://127.0.0.1:9612/v1/responses', apiKey: 'local-test', model: 'mock', workdir: dir });
    const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
    rounds.push([call('native-write', 'write', { path: 'tool.txt', content: 'hello native rust' })]);
    rounds.push([call('native-edit', 'edit', { path: 'tool.txt', old_string: 'hello', new_string: 'verified' })]);
    rounds.push([call('native-read', 'read', { path: 'tool.txt' }), call('native-shell', 'shell', { command: 'printf worker-rust-shell' })]);
    rounds.push([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'verified' }] }]);
    rounds.push([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'task reported' }] }]);
    const task = await request('tasks.dispatch', { title: 'Rust 原生执行验收', goal: 'local native acceptance', device: device.id, workdir: dir });
    const session = { id: task.task_id };
    await wait((m) => m.type === 'agent.event' && m.data.session_id === session.id && m.data.type === 'done', 'agent done');
    const outputs = messages.filter((m) => m.type === 'agent.event' && m.data.session_id === session.id && m.data.type === 'function_call_output' && m.data.item).map((m) => JSON.parse(m.data.item.output));
    assert.equal(outputs.length, 4);
    for (const output of outputs) assert.equal(output.success, true, JSON.stringify(output));
    assert.equal(fs.readFileSync(path.join(dir, 'tool.txt'), 'utf8'), 'verified native rust');
    assert.ok(outputs.some((o) => o.text.includes('worker-rust-shell')));
    console.log('✓ 云端 AI → Worker → Rust write / edit / read / shell 完整循环');
    console.log('全部通过');
} finally {
    ws.close(); model.close();
    fs.rmSync(dir, { recursive: true, force: true });
}
