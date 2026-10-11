// Isolated host only: injected before production module; never shipped in production.
(() => {
  const original = window.fetch.bind(window);
  window.addEventListener('securitypolicyviolation', (event) => {
    void original('/validation-api/violation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directive: event.effectiveDirective, disposition: event.disposition }),
    });
  });
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    // Explicit BYOK profile must use this proxy. All direct external fetch is disabled.
    if (
      url.origin !== location.origin ||
      (/\/chat\/completions\/?$/.test(url.pathname) && url.pathname !== '/validation-api/v1/chat/completions')
    )
      return Promise.reject(
        new Error(
          'Isolated validation: configure BYOK endpoint /validation-api/v1 and explicitly start in validation page',
        ),
      );
    return original(input, init);
  };
})();
