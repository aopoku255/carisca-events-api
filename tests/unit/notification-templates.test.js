import { render, templates } from '../../src/core/notifications/templates/index.js';

describe('email banner', () => {
  test('a registration email with a banner file id shows it at the top', () => {
    const { html } = render('registration_confirmed', {
      firstName: 'Ama', eventTitle: 'Supply Chain Summit', reference: 'CAR-2026-000123', bannerFileId: 42,
    });
    expect(html).toMatch(/<img src="[^"]*\/files\/42"/);
  });

  test('no banner file id means no banner image at all', () => {
    const { html } = render('registration_confirmed', {
      firstName: 'Ama', eventTitle: 'Supply Chain Summit', reference: 'CAR-2026-000123',
    });
    expect(html).not.toMatch(/\/files\/\d+/);
  });

  test('a template with no event context (password reset) never shows a banner', () => {
    const { html } = render('password_reset', { firstName: 'Ama', expiresInMinutes: 30 });
    expect(html).not.toMatch(/\/files\/\d+/);
  });
});

describe('the trilogo', () => {
  test('appears in every template, not just registration ones', () => {
    for (const name of Object.keys(templates)) {
      const { html } = render(name, {});
      expect(html).toContain('carisca-trilogo.png');
    }
  });
});

describe('no em dashes anywhere in rendered output', () => {
  test.each(Object.keys(templates))('%s', (name) => {
    const { subject, html, text } = render(name, {});
    expect(subject).not.toContain('—');
    expect(html).not.toContain('—');
    expect(text).not.toContain('—');
  });
});

describe('"view my registration" links', () => {
  // /dashboard/registrations on its own is not a page — only one per
  // registration exists — so linking to it 404s.
  test.each(['registration_confirmed', 'event_updated'])('%s links to that registration', (template) => {
    const { html } = render(template, {
      firstName: 'Ama', eventTitle: 'Supply Chain Summit', reference: 'CAR-CPD-26-ABC123', changed: ['venue'],
    });
    expect(html).toMatch(/href="[^"]*\/dashboard\/registrations\/CAR-CPD-26-ABC123"/);
  });

  test('without a reference it falls back to the dashboard, never the bare path', () => {
    const { html } = render('event_updated', { firstName: 'Ama', eventTitle: 'X', changed: [] });
    expect(html).not.toMatch(/\/dashboard\/registrations"/);
    expect(html).toMatch(/href="[^"]*\/dashboard"/);
  });
});
