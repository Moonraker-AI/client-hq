(function() {
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function() {
      var h = document.documentElement;
      if (h.getAttribute('data-theme') === 'light') {
        h.setAttribute('data-theme', 'dark');
        themeBtn.textContent = '☀️';
      } else {
        h.setAttribute('data-theme', 'light');
        themeBtn.textContent = '🎑';
      }
    });
  }
  var toggles = document.querySelectorAll('.collapsible-toggle');
  for (var i = 0; i < toggles.length; i++) {
    toggles[i].addEventListener('click', function() {
      this.parentElement.classList.toggle('open');
    });
  }
  var sections = document.querySelectorAll('section[id]');
  var navLinks = document.querySelectorAll('.side-nav a');
  function updateNav() {
    var c = '';
    sections.forEach(function(s) {
      if (window.scrollY >= s.offsetTop - 200) c = s.id;
    });
    navLinks.forEach(function(l) {
      l.classList.remove('active');
      if (l.getAttribute('href') === '#' + c) l.classList.add('active');
    });
  }
  window.addEventListener('scroll', updateNav);
  updateNav();
})();