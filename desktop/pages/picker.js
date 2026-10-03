const grid = document.getElementById('grid');
const go = document.getElementById('go');
let sources = [];
let kind = 'screen';
let selected = null;

function render() {
  grid.innerHTML = '';
  for (const s of sources.filter((x) => x.kind === kind)) {
    const b = document.createElement('button');
    b.className = 'src' + (s.id === selected ? ' selected' : '');
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = s.thumbnail;
    const name = document.createElement('div');
    name.className = 'name';
    if (s.icon) { const i = document.createElement('img'); i.src = s.icon; name.append(i); }
    name.append(document.createTextNode(s.name));
    b.append(img, name);
    b.onclick = () => { selected = s.id; go.disabled = false; render(); };
    b.ondblclick = () => { selected = s.id; choose(); };
    grid.append(b);
  }
}

function choose() {
  if (!selected) return;
  window.straighttalkDesktop.pickerChoose({ id: selected, audio: document.getElementById('audio').checked });
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    kind = t.dataset.kind;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    render();
  };
});
go.onclick = choose;
document.getElementById('cancel').onclick = () => window.straighttalkDesktop.pickerChoose(null);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.straighttalkDesktop.pickerChoose(null); });

window.straighttalkDesktop.pickerSources().then((list) => {
  sources = list;
  const screens = list.filter((s) => s.kind === 'screen');
  if (screens.length === 1) { selected = screens[0].id; go.disabled = false; }
  render();
});
