'use strict';

/**
 * Windows maximize can spill past the usable work area (under the taskbar).
 * Helpers keep BrowserWindow bounds inside screen.workArea.
 */

function exceedsWorkArea(bounds, workArea, slack = 2) {
  if (!bounds || !workArea) return false;
  return (
    bounds.y < workArea.y - slack ||
    bounds.x < workArea.x - slack ||
    bounds.width > workArea.width + slack ||
    bounds.height > workArea.height + slack ||
    bounds.y + bounds.height > workArea.y + workArea.height + slack ||
    bounds.x + bounds.width > workArea.x + workArea.width + slack
  );
}

function workAreaBounds(workArea) {
  return {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height
  };
}

/**
 * If a maximized/fullscreen window paints past the taskbar, exit that state
 * and size exactly to the display work area (pseudo-maximize).
 * Returns true when bounds were corrected.
 */
function clampWindowToWorkArea(win, screenApi) {
  if (!win || win.isDestroyed() || !screenApi) return false;
  if (process.platform !== 'win32') return false;
  if (!win.isMaximized() && !win.isFullScreen()) return false;

  const display = screenApi.getDisplayMatching(win.getBounds());
  const wa = display && display.workArea;
  if (!wa || !(wa.width > 0) || !(wa.height > 0)) return false;

  const bounds = win.getBounds();
  if (!exceedsWorkArea(bounds, wa)) return false;

  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  win.setBounds(workAreaBounds(wa));
  return true;
}

module.exports = {
  exceedsWorkArea,
  workAreaBounds,
  clampWindowToWorkArea
};
