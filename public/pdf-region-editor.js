import { orderedBounds, viewportBounds } from './pdf-region.js';

// Storage is injected so this editor can be used with any full-page view.
export function createRegionEditor({ host, view, manifestId, regions, onSave, onDelete, onShow }) {
  let disposed = false, selecting = false, start = null, bounds = null, busy = false;
  const controls = document.createElement('div');
  controls.className = 'pdf-region-controls';
  const select = button('Select region', () => {
    if (busy) return;
    selecting = !selecting;
    bounds = null;
    update();
  });
  const form = document.createElement('form');
  form.className = 'pdf-region-form';
  const name = document.createElement('input');
  name.placeholder = 'Region name';
  name.setAttribute('aria-label', 'Region name');
  name.required = true;
  name.maxLength = 200;
  const save = button('Save region');
  save.type = 'submit';
  const cancel = button('Cancel selection', () => {
    if (busy) return;
    selecting = false; bounds = null; start = null; update();
  });
  const status = document.createElement('span');
  status.className = 'pdf-region-status';
  status.setAttribute('role', 'status');
  form.append(name, save, cancel);
  const list = document.createElement('div');
  list.className = 'pdf-region-list';
  controls.append(select, form, status, list);
  host.append(controls);
  const overlay = document.createElement('div');
  overlay.className = 'pdf-region-overlay';
  view.div.append(overlay);

  function button(label, onclick) {
    const result = document.createElement('button');
    result.type = 'button';
    result.className = 'button small secondary';
    result.textContent = label;
    result.onclick = onclick;
    return result;
  }
  function mark(rect, label, draft = false) {
    const [left, top, right, bottom] = viewportBounds(view.viewport, rect);
    const box = document.createElement('div');
    box.className = `pdf-region-box${draft ? ' draft' : ''}`;
    box.title = label;
    box.style.left = `${100 * left / view.viewport.width}%`;
    box.style.top = `${100 * top / view.viewport.height}%`;
    box.style.width = `${100 * (right - left) / view.viewport.width}%`;
    box.style.height = `${100 * (bottom - top) / view.viewport.height}%`;
    overlay.append(box);
  }
  function paint() {
    overlay.replaceChildren();
    for (const region of regions) mark(region.bounds, region.name);
    if (bounds) mark(bounds, 'New region', true);
  }
  function update() {
    overlay.classList.toggle('selecting', selecting && !busy);
    select.textContent = selecting ? 'Exit selection' : 'Select region';
    select.setAttribute('aria-pressed', String(selecting));
    form.hidden = !selecting;
    save.disabled = busy || !bounds || !!start;
    select.disabled = cancel.disabled = name.disabled = busy;
    status.textContent = selecting ? 'Drag a rectangle on the page, then name and save it.' : '';
    paint();
  }
  function renderList() {
    list.replaceChildren();
    for (const region of regions) {
      const item = document.createElement('span');
      item.className = 'pdf-region-item';
      const open = button(region.name, () => { if (!busy) onShow(region); });
      open.title = `View crop ${JSON.stringify(region.bounds)}`;
      const remove = button('Delete', async () => {
        if (busy) return;
        busy = true; update(); remove.disabled = true;
        try {
          await onDelete(region.id);
          if (disposed) return;
          regions = regions.filter(value => value.id !== region.id);
          renderList();
          busy = false; update();
        } catch (error) {
          if (disposed) return;
          busy = false; update(); remove.disabled = false;
          status.textContent = error.message;
        }
      });
      remove.setAttribute('aria-label', `Delete region ${region.name}`);
      item.append(open, remove);
      list.append(item);
    }
  }
  function point(event) {
    const rect = overlay.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * view.viewport.width;
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * view.viewport.height;
    const [px, py] = view.viewport.convertToPdfPoint(x, y);
    const [xmin, ymin, xmax, ymax] = orderedBounds(view.pdfPage.view);
    return [Math.max(xmin, Math.min(xmax, px)), Math.max(ymin, Math.min(ymax, py))];
  }
  overlay.onpointerdown = event => {
    if (!selecting || busy || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    overlay.setPointerCapture(event.pointerId);
    start = { pointerId: event.pointerId, point: point(event), x: event.clientX, y: event.clientY };
    bounds = null; update();
  };
  overlay.onpointermove = event => {
    if (!start || start.pointerId !== event.pointerId) return;
    bounds = orderedBounds([...start.point, ...point(event)]);
    paint();
  };
  overlay.onpointerup = event => {
    if (!start || start.pointerId !== event.pointerId) return;
    bounds = Math.abs(event.clientX - start.x) >= 3 && Math.abs(event.clientY - start.y) >= 3
      ? orderedBounds([...start.point, ...point(event)]) : null;
    start = null;
    overlay.releasePointerCapture(event.pointerId);
    update();
    if (bounds) name.focus();
  };
  overlay.onpointercancel = overlay.onlostpointercapture = () => {
    if (start) { start = null; bounds = null; update(); }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !bounds || start) return;
    busy = true; update();
    try {
      const region = await onSave({ pageManifestId: manifestId, name: name.value, bounds });
      if (disposed) return;
      regions = [...regions, region];
      selecting = false; bounds = null; name.value = ''; busy = false;
      renderList(); update();
      status.textContent = 'Region saved.';
    } catch (error) {
      if (disposed) return;
      busy = false; update(); status.textContent = error.message;
    }
  };
  renderList(); update();
  return () => { disposed = true; overlay.remove(); controls.remove(); };
}
