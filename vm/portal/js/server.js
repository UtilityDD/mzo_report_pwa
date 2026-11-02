/* Server page (#/server): the VM's CPU, memory, disk, network, services and processes.
 * The page itself is vm/stats/www/vmstats.js (also the public stats site); Caddy serves it and the
 * sampler's JSON under /vmstats/ on this host, so the portal's CSP (self only) allows both.
 */
(function (w) {
  'use strict';
  var P = w.Portal = w.Portal || {};
  P.server = {
    page: function (host) {
      if (!w.VmStats) {
        host.innerHTML = '<section class="ui-panel"><div class="ui-empty">The server stats script did not load.</div></section>';
        return null;
      }
      return w.VmStats.mount(host, { data: '/vmstats/data/', title: 'Server' });
    }
  };
})(window);
