import { describe, expect, it } from 'vitest';
import { accountPage, mcpIdentityPage } from '../src/web/pages.js';

const mockConfig = {
  issuer: 'https://auth.example.org',
  basePath: '',
  brand: {
    name: 'Tunnus Test',
    tagline: 'Identity Service',
    color: '#7e003e',
  },
  defaultLocale: 'en',
  keyEncryptionSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

const ctx = {
  config: /** @type {any} */ (mockConfig),
  locale: /** @type {const} */ ('en'),
};

describe('MCP Identity Directory & Bulk Ref UI', () => {
  const sampleUsers = [
    { id: 'u1', email: 'alice@example.com', display_name: 'Alice Wonder' },
    { id: 'u2', email: 'bob@example.com', display_name: 'Bob Builder' },
  ];

  const sampleClients = [
    { auth_kind: 'oauth', auth_client_key: 'chatgpt-prod', label: 'OAuth: ChatGPT' },
    { auth_kind: 'admin_token', auth_client_key: 'tok-123', label: 'Admin token: CLI' },
  ];

  const sampleSubjects = [
    {
      subject_id: 'sub-1',
      tunnus_user_id: 'u1',
      email: 'alice@example.com',
      display_name: 'Alice Wonder',
      pseudonyms: [
        { id: 'p1', pseudonym: 'A-101', is_preferred: true },
        { id: 'p2', pseudonym: 'Agent-Blue', is_preferred: false },
      ],
      refs: [
        {
          id: 'ref-1',
          handle: 'AAAABBBBCCCC1111',
          auth_kind: 'oauth',
          auth_client_key: 'chatgpt-prod',
          expires_at: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
          revoked_at: null,
        },
      ],
    },
    {
      subject_id: 'sub-2',
      tunnus_user_id: null,
      label: 'External Contractor',
      pseudonyms: [],
      refs: [],
    },
  ];

  it('renders compact directory table, copy buttons, checkboxes, and quick bulk ref creator in mcpIdentityPage', () => {
    const html = mcpIdentityPage(ctx, {
      basePath: '',
      csrf: 'csrf-token-123',
      users: sampleUsers,
      clients: sampleClients,
      subjects: sampleSubjects,
    });

    // 1. Quick Bulk Reference Creator
    expect(html).toContain('Quick Bulk Reference Creator');
    expect(html).toContain('id="quick-bulk-input"');
    expect(html).toContain('id="quick-bulk-btn"');
    expect(html).toContain('id="quick-bulk-chips"');
    expect(html).toContain('datalist id="quick-bulk-users-dl"');
    expect(html).toContain('alice@example.com');
    expect(html).toContain('bob@example.com');

    // 2. Compact Directory Table
    expect(html).toContain('class="compact-table"');
    expect(html).toContain('id="dir-filter"');
    expect(html).toContain('id="check-all"');
    expect(html).toContain('id="bulk-action-bar"');
    expect(html).toContain('id="btn-copy-selected-refs"');
    expect(html).toContain('id="btn-copy-selected-pseudos"');

    // 3. Subjects & Pseudonyms
    expect(html).toContain('Alice Wonder');
    expect(html).toContain('pseudo:A-101');
    expect(html).toContain('pseudo:Agent-Blue');
    expect(html).toContain('data-copy="pseudo:A-101"');

    // 4. References & Inline Copy Buttons
    expect(html).toContain('ref:AAAABBBBCCCC1111');
    expect(html).toContain('data-copy="ref:AAAABBBBCCCC1111"');
    expect(html).toContain('📋 Copy');
    expect(html).toContain('aria-label="Copy reference ref:AAAABBBBCCCC1111"');
    expect(html).toContain('data-refs="ref:AAAABBBBCCCC1111"');

    // 5. Client Script & A11y Live Region
    expect(html).toContain('id="a11y-status"');
    expect(html).toContain('role="status"');
    expect(html).toContain('copyToClipboard');
  });

  it('renders MCP Pseudonyms & References card with quick creator and copyable refs on accountPage when mcpIdentities is present', () => {
    const html = accountPage(ctx, {
      basePath: '',
      email: 'admin@example.org',
      displayName: 'Admin User',
      groups: ['admin'],
      totpEnabled: true,
      freshEmail: true,
      csrf: 'csrf-1',
      mcpIdentities: {
        subjects: sampleSubjects,
        users: sampleUsers,
        clients: sampleClients,
      },
    });

    expect(html).toContain('MCP Pseudonyms & References');
    expect(html).toContain('Quick Bulk Reference Creator');
    expect(html).toContain('id="quick-bulk-input"');
    expect(html).toContain('ref:AAAABBBBCCCC1111');
    expect(html).toContain('data-copy="ref:AAAABBBBCCCC1111"');
    expect(html).toContain('📋 Copy');
    expect(html).toContain('Open full MCP directory & settings →');
  });
});
