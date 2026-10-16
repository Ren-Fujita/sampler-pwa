// Browser objects and application renderers are supplied lazily by the caller.
export function createLayout({ getWindow, getDocument, getElement, drawWave, syncPlaybackDisplay }) {
  function fitPads() {
    const grid = getElement('pads');
    const height = grid.clientHeight || grid.getBoundingClientRect().height;
    if (!height)return;
    const style = getWindow().getComputedStyle?.(grid);
    const frame = parseFloat(style?.getPropertyValue('--pad-frame-space')) || 46;
    const rowHeight = (height - frame) / 3;
    grid.dataset.density = rowHeight >= 100 ? 'full' : rowHeight >= 58 ? 'compact'
      : rowHeight >= 40 ? 'short' : rowHeight >= 24 ? 'minimal' : 'micro';
    grid.style.setProperty('--pad-number-size', Math.max(8, Math.min(12, Math.floor(rowHeight - 4))) + 'px');
  }

  function fitViewport() {
    const browser = getWindow();
    const viewport = browser.visualViewport;
    const width = viewport?.width || browser.innerWidth;
    const height = viewport?.height || browser.innerHeight;
    if (!width || !height)return;
    const style = getDocument().documentElement.style;
    style.setProperty('--viewport-width', width + 'px');
    style.setProperty('--viewport-height', height + 'px');
    style.setProperty('--viewport-top', (viewport?.offsetTop || 0) + 'px');
    style.setProperty('--viewport-left', (viewport?.offsetLeft || 0) + 'px');
    const device = getElement('device');
    device.classList.toggle('compact', height <= 620);
    device.classList.toggle('landscape', height <= 540 && width >= 640);
    device.classList.toggle('short-portrait', height < 480 && width < 640);
    fitPads();
    syncPlaybackDisplay();
  }

  function bind() {
    const browser = getWindow();
    browser.addEventListener('resize', fitViewport);
    if (browser.visualViewport) {
      browser.visualViewport.addEventListener('resize', fitViewport);
      browser.visualViewport.addEventListener('scroll', fitViewport);
    }
    if (browser.ResizeObserver) {
      const observer = new browser.ResizeObserver(() => {
        drawWave();
        fitPads();
        syncPlaybackDisplay();
      });
      observer.observe(getElement('waveZone'));
      observer.observe(getElement('pads'));
      observer.observe(getElement('headerDisplay'));
    }
  }

  return { fitPads, fitViewport, bind };
}
