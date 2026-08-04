const scrollButtons = document.querySelectorAll('[data-scroll]');
scrollButtons.forEach((button) => {
  button.addEventListener('click', () => document.querySelector(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' }));
});

const colorName = document.querySelector('#color-name');
document.querySelectorAll('.swatch').forEach((swatch) => {
  swatch.addEventListener('click', () => {
    document.querySelector('.swatch.active')?.classList.remove('active');
    swatch.classList.add('active');
    colorName.textContent = swatch.dataset.color;
  });
});

document.querySelector('#order-button').addEventListener('click', () => {
  const toast = document.querySelector('.toast');
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 3000);
});
