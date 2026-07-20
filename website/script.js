/* =====================================================
   Agent-Nuvira — Website Interactions
   Scroll animations, navbar, copy buttons, particles
   ===================================================== */

document.addEventListener('DOMContentLoaded', () => {

  // --- Sticky Navbar ---
  const navbar = document.getElementById('navbar');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;
    if (currentScroll > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
    lastScroll = currentScroll;
  });

  // --- Mobile Nav Toggle ---
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  navToggle.addEventListener('click', () => {
    navToggle.classList.toggle('active');
    navLinks.classList.toggle('active');
  });

  // Close nav on link click
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      navToggle.classList.remove('active');
      navLinks.classList.remove('active');
    });
  });

  // --- Smooth Scroll for Anchor Links ---
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      if (href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        const navHeight = navbar.offsetHeight;
        const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navHeight;
        window.scrollTo({ top: targetPosition, behavior: 'smooth' });
      }
    });
  });

  // --- Copy to Clipboard ---
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy');
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        const originalHTML = btn.innerHTML;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        `;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = originalHTML;
        }, 2000);
      } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
    });
  });

  // --- Scroll Animation with Intersection Observer ---
  const animateElements = () => {
    const elements = document.querySelectorAll(
      '.feature-card, .provider-card, .extension-card, .quickstart-step, .pipeline-agent, .metric'
    );

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const delay = entry.target.getAttribute('data-delay') || '0';
          entry.target.style.transitionDelay = `${delay}ms`;
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    });

    elements.forEach(el => {
      el.classList.add('fade-in');
      observer.observe(el);
    });
  };

  animateElements();

  // --- Particle Effect for Hero Background ---
  const createParticles = () => {
    const container = document.getElementById('particles');
    if (!container) return;

    const particleCount = 40;

    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      const size = Math.random() * 3 + 1;
      const x = Math.random() * 100;
      const y = Math.random() * 100;
      const duration = Math.random() * 20 + 10;
      const delay = Math.random() * 10;

      particle.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        background: rgba(99, 102, 241, ${Math.random() * 0.3 + 0.1});
        border-radius: 50%;
        left: ${x}%;
        top: ${y}%;
        pointer-events: none;
        animation: float-particle ${duration}s ease-in-out ${delay}s infinite;
      `;

      container.appendChild(particle);
    }
  };

  createParticles();

  // --- Terminal Animation ---
  const animateTerminal = () => {
    const logs = document.querySelectorAll('.terminal-output .log');
    if (!logs.length) return;

    logs.forEach((log, index) => {
      log.style.opacity = '0';
      log.style.display = 'block';
      setTimeout(() => {
        log.style.transition = 'opacity 0.5s ease';
        log.style.opacity = '1';
      }, 800 + index * 600);
    });
  };

  // Start terminal animation after a short delay
  setTimeout(animateTerminal, 1500);
});

// --- Add CSS for fade-in animation dynamically ---
const style = document.createElement('style');
style.textContent = `
  .fade-in {
    opacity: 0;
    transform: translateY(24px);
    transition: opacity 0.6s ease, transform 0.6s ease;
  }

  .fade-in.visible {
    opacity: 1;
    transform: translateY(0);
  }

  @keyframes float-particle {
    0%, 100% { transform: translateY(0) translateX(0); }
    25% { transform: translateY(-20px) translateX(10px); }
    50% { transform: translateY(-10px) translateX(-10px); }
    75% { transform: translateY(-30px) translateX(5px); }
  }
`;
document.head.appendChild(style);
