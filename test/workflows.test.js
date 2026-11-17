import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (/** @type {string} */ rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const image = /** @type {any} */ (parse(read('.github/workflows/publish-image.yml')));
const ci = /** @type {any} */ (parse(read('.github/workflows/ci.yml')));
const dependabot = /** @type {any} */ (parse(read('.github/dependabot.yml')));

describe('publish-image workflow', () => {
  it('runs on main pushes, version tags and manual dispatch', () => {
    expect(image.on.push.branches).toEqual(['main']);
    expect(image.on.push.tags).toEqual(['v*']);
    expect(image.on).toHaveProperty('workflow_dispatch');
  });

  it('builds with provenance, SBOM and the GitHub Actions cache', () => {
    const build = image.jobs.publish.steps.find((/** @type {any} */ s) =>
      s.uses?.startsWith('docker/build-push-action'),
    );
    expect(build.with.provenance).toBe(true);
    expect(build.with.sbom).toBe(true);
    expect(build.with['cache-from']).toBe('type=gha');
    expect(build.with['cache-to']).toBe('type=gha,mode=max');
  });

  it('serialises runs per ref', () => {
    expect(image.concurrency.group).toContain('github.ref');
  });

  it('tags main pushes as main and never as latest', () => {
    const meta = image.jobs.publish.steps.find((/** @type {any} */ s) => s.id === 'meta');
    const tags = meta.with.tags;
    expect(tags).toContain("type=raw,value=main,enable=${{ github.ref == 'refs/heads/main' }}");
    const latestLine = tags.split('\n').find((/** @type {any} */ l) => l.includes('value=latest'));
    expect(latestLine).not.toContain('refs/heads/main');
    expect(latestLine).toContain("github.ref_type == 'tag'");
  });

  it('gates the deploy job on the event and ref, and on the webhook secret inside the job', () => {
    const deploy = image.jobs.deploy;
    expect(deploy.needs).toBe('publish');
    expect(deploy.if).toContain("github.event_name == 'push'");
    expect(deploy.if).toContain('refs/heads/main');
    expect(deploy.if).toContain("startsWith(github.ref, 'refs/tags/v')");
    const check = deploy.steps.find((/** @type {any} */ s) => s.id === 'configured');
    expect(check.env.DEPLOY_WEBHOOK_URL).toBe('${{ secrets.DEPLOY_WEBHOOK_URL }}');
  });

  it('sends the token only as a bearer header and never echoes it', () => {
    const post = image.jobs.deploy.steps.find(
      (/** @type {any} */ s) => s.name === 'POST the deploy webhook',
    );
    expect(post.run).toContain('--fail');
    expect(post.run).toContain('--max-time 30');
    expect(post.run).not.toMatch(/echo[^\n]*DEPLOY_WEBHOOK/);
    expect(post.run).not.toMatch(/echo[^\n]*TOKEN/);
  });
});

describe('ci workflow', () => {
  it('has read-only top-level permissions', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
  });

  it('cancels superseded pull request runs only', () => {
    expect(ci.concurrency.group).toContain('github.ref');
    expect(ci.concurrency['cancel-in-progress']).toContain("github.event_name == 'pull_request'");
  });

  it('runs the production audit', () => {
    const runs = ci.jobs.check.steps.map((/** @type {any} */ s) => s.run);
    expect(runs).toContain('npm audit --omit=dev --audit-level=high');
  });
});

describe('dependabot', () => {
  it('updates npm, github-actions and docker weekly', () => {
    const ecosystems = dependabot.updates
      .map((/** @type {any} */ u) => u['package-ecosystem'])
      .sort();
    expect(ecosystems).toEqual(['docker', 'github-actions', 'npm']);
    for (const u of dependabot.updates) expect(u.schedule.interval).toBe('weekly');
  });
});
