'use strict';

document.addEventListener('click', (event) => {
  const button = event.target && event.target.closest
    ? event.target.closest('[data-print]')
    : null;
  if (!button) return;
  event.preventDefault();
  window.print();
});
