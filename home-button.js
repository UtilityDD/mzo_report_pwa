document.addEventListener("DOMContentLoaded", () => {
  const homeBtn = document.createElement('div');
  homeBtn.className = 'fixed-action-btn';
  homeBtn.innerHTML = `
    <a href="index.html" class="btn-floating btn-large blue tooltipped" data-position="left" data-tooltip="Home">
      <i class="fa-solid fa-house"></i>
    </a>
  `;
  document.body.appendChild(homeBtn);

  // Initialize tooltip
  const tooltips = document.querySelectorAll('.tooltipped');
  if (M && M.Tooltip) M.Tooltip.init(tooltips);
});
