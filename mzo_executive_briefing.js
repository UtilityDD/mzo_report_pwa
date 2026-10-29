/**
 * mzo_executive_briefing.js
 * Homepage badge helper for 1-Click Executive Briefing.
 * Fetches priority counts to display on the Executive Briefing action button.
 */

(function () {
  'use strict';

  async function updateExecutiveBadge() {
    try {
      const res = await fetch('/api/executive/briefing', { credentials: 'same-origin' });
      if (res.ok) {
        const json = await res.json();
        const pill = document.getElementById('briefingAlertPill');
        const headerBtn = document.getElementById('btnExecutiveBriefingHeader');
        if (json && json.briefing && json.briefing.summaryCounts) {
          const crit = json.briefing.summaryCounts.critical || 0;
          if (pill) pill.textContent = crit > 0 ? `${crit} 🔴` : '⚡';
          if (headerBtn) headerBtn.title = `Critical Analytics (${crit} Priority Bottlenecks)`;
        }
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateExecutiveBadge);
  } else {
    updateExecutiveBadge();
  }
})();
