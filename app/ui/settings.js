const fields = ['url', 'token', 'name', 'description'];
const error = document.getElementById('error');
const invoke = window.__TAURI__.core.invoke;
invoke('read_settings').then((config) => {
    for (const field of fields) document.getElementById(field).value = config?.[field] || '';
    if (config) document.getElementById('token').required = false;
}).catch((e) => { error.textContent = String(e); });
document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('save');
    button.disabled = true;
    error.textContent = '';
    try {
        const input = Object.fromEntries(fields.map((field) => [field, document.getElementById(field).value]));
        await invoke('save_settings', { input });
    } catch (e) { error.textContent = String(e); }
    finally { button.disabled = false; }
});
