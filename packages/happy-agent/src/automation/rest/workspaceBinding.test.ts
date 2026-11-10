import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyWorkspace, workspaceBranch, workspaceResult } from './taskWorkspaces';
import type { Workspace } from './taskQueue';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();

/** A real repository plus one managed worktree, mirroring what prepareWorkspace records. */
function setup() {
    const root = mkdtempSync(join(tmpdir(), 'happy-binding-')); roots.push(root);
    const repo = join(root, 'repo'); mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 'fixture@invalid'); git(repo, 'config', 'user.name', 'fixture');
    writeFileSync(join(repo, 'baseline'), 'unchanged'); git(repo, 'add', 'baseline'); git(repo, 'commit', '-qm', 'base');
    const baseCommit = git(repo, 'rev-parse', 'HEAD'), cwd = join(root, 'worktree'), branch = 'dot-task/fixture';
    git(repo, 'worktree', 'add', '-q', '-b', branch, cwd, baseCommit);
    const workspace: Workspace = { id: 'a'.repeat(64), fingerprint: 'b'.repeat(64), grantID: 'grant-a', projectID: 'project',
        root: repo, repository: join(repo, '.git'), cwd, branch, baseCommit, execution: { mode: 'worktree', resources: [] },
        temporaryDirectory: join(root, 'temporary'), port: 20000, stage: 'ready' };
    return { repo, cwd, baseCommit, branch, workspace };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('accepts a task that commits on the assigned branch and reports that branch', () => {
    const f = setup();
    writeFileSync(join(f.cwd, 'fix.txt'), 'work'); git(f.cwd, 'add', 'fix.txt'); git(f.cwd, 'commit', '-qm', 'fix');
    expect(verifyWorkspace(f.workspace)).toEqual({ branch: f.branch });
    expect(workspaceBranch(f.workspace)).toBe(f.branch);
    expect(workspaceResult(f.workspace).resultCommit).toBe(git(f.cwd, 'rev-parse', 'HEAD'));
});

it('accepts a new branch created from the assigned history and reports the real branch', () => {
    const f = setup();
    // Exactly what the Console fix session did: create and switch to its own branch.
    git(f.cwd, 'switch', '-q', '-c', 'fix/console-tag-thumbnail-crash');
    writeFileSync(join(f.cwd, 'fix.txt'), 'work'); git(f.cwd, 'add', 'fix.txt'); git(f.cwd, 'commit', '-qm', 'fix');
    expect(verifyWorkspace(f.workspace)).toEqual({ branch: 'fix/console-tag-thumbnail-crash' });
    expect(workspaceBranch(f.workspace)).toBe('fix/console-tag-thumbnail-crash');
    expect(f.workspace.branch).toBe(f.branch); // The ledger's assigned name stays the creation identity.
});

it('rejects a detached HEAD because no branch can be fetched or reviewed', () => {
    const f = setup();
    git(f.cwd, 'checkout', '-q', '--detach');
    expect(workspaceBranch(f.workspace)).toBeNull();
    expect(() => verifyWorkspace(f.workspace)).toThrow('WORKTREE_BINDING_CHANGED');
});

it('rejects a rewrite that no longer descends from the recorded baseline', () => {
    const f = setup();
    git(f.cwd, 'checkout', '-q', '--orphan', 'orphan/rewrite');
    git(f.cwd, 'commit', '-q', '-m', 'rewrite', '--allow-empty');
    expect(git(f.cwd, 'rev-parse', 'HEAD')).not.toBe(f.baseCommit);
    expect(() => verifyWorkspace(f.workspace)).toThrow('WORKTREE_BINDING_CHANGED');
});

it('rejects taking over the branch the root checkout itself is on', () => {
    const f = setup();
    // Only `-f -B` can do this; a plain checkout is refused by Git itself.
    git(f.cwd, 'checkout', '-f', '-B', 'main');
    expect(git(f.repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(() => verifyWorkspace(f.workspace)).toThrow('WORKTREE_BINDING_CHANGED');
});

it('rejects a worktree whose repository binding no longer matches', () => {
    const f = setup();
    const other = join(f.workspace.root, '..', 'other'); mkdirSync(other);
    expect(() => verifyWorkspace({ ...f.workspace, repository: join(other, '.git') })).toThrow('WORKTREE_BINDING_CHANGED');
});