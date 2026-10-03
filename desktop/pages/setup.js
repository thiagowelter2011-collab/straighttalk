const params = new URLSearchParams(location.search);
const input = document.getElementById('url');
const error = document.getElementById('error');
input.value = params.get('url') || '';
error.textContent = params.get('error') || '';

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  try {
    await window.straighttalkDesktop.saveServer(input.value);
  } catch (err) {
    error.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});
