import { describe, expect, it } from 'vitest'

import {
  isCommitCommand,
  checkPassed,
  blockReason,
  hasUnpushedCommits,
  shouldWarnUnpushed,
} from './gates'

describe('build-gates decision logic', () => {
  describe('isCommitCommand', () => {
    it('flags a plain git commit', () => {
      expect(isCommitCommand('git commit -m "x"')).toBe(true)
    })

    it('flags git add', () => {
      expect(isCommitCommand('git add -A')).toBe(true)
      expect(isCommitCommand('git add .')).toBe(true)
    })

    it('flags a commit deeper in a compound command', () => {
      expect(isCommitCommand('cd foo && git commit -am "x"')).toBe(true)
      expect(isCommitCommand('npm test; git add src/')).toBe(true)
    })

    it('flags a commit however the whitespace is shaped', () => {
      expect(isCommitCommand('git  commit -m "x"')).toBe(true) // double space
      expect(isCommitCommand('git\tadd .')).toBe(true)
    })

    it('flags a commit dressed up with global git options', () => {
      expect(isCommitCommand('git -c user.name=x commit -m "y"')).toBe(true)
      expect(isCommitCommand('git -C /repo add .')).toBe(true)
      expect(isCommitCommand('git --no-pager commit')).toBe(true)
      expect(isCommitCommand('git -c user.name=x -c user.email=y commit')).toBe(
        true,
      )
    })

    it('flags a commit dressed up with a quoted, space-carrying option value', () => {
      expect(isCommitCommand('git -c user.name="a b" commit -m "y"')).toBe(true)
      expect(isCommitCommand(`git -c user.name='a b' commit`)).toBe(true)
      expect(isCommitCommand('git -c "user.name=a b" commit')).toBe(true)
    })

    it('flags a commit behind a long option with a separated value', () => {
      expect(isCommitCommand('git --git-dir /x commit')).toBe(true)
    })

    it('does not flag non-committing verbs behind the same options', () => {
      expect(isCommitCommand('git -c user.name=x status')).toBe(false)
      expect(isCommitCommand('git --no-pager log --oneline')).toBe(false)
    })

    it('ignores non-committing git commands', () => {
      expect(isCommitCommand('git status')).toBe(false)
      expect(isCommitCommand('git log --oneline')).toBe(false)
      expect(isCommitCommand('git diff')).toBe(false)
    })

    it('ignores commands that merely mention commit as a substring', () => {
      expect(isCommitCommand('echo "commit your code"')).toBe(false)
      expect(isCommitCommand('cat git-committer.txt')).toBe(false)
      expect(isCommitCommand('legit add file')).toBe(false) // "git" mid-word
      expect(isCommitCommand('git committer')).toBe(false) // "commit" mid-word
    })

    it('ignores unrelated commands', () => {
      expect(isCommitCommand('npm run check')).toBe(false)
      expect(isCommitCommand('ls -la')).toBe(false)
    })
  })

  describe('checkPassed', () => {
    it('passes on exit code 0', () => {
      expect(checkPassed(0)).toBe(true)
    })
    it('fails on any non-zero exit code', () => {
      expect(checkPassed(1)).toBe(false)
      expect(checkPassed(2)).toBe(false)
    })
  })

  describe('blockReason', () => {
    it('summarizes a failed check with its output tail', () => {
      const reason = blockReason('npm run check', 'eslint: 3 problems\n')
      expect(reason).toMatch(/check/i)
      expect(reason).toMatch(/eslint/)
    })
  })

  describe('hasUnpushedCommits', () => {
    it('is true when git reports ahead commits', () => {
      // `git log @{u}..HEAD --oneline` prints a line per unpushed commit
      expect(hasUnpushedCommits('abc123 wip\n')).toBe(true)
    })
    it('is false when there is no output', () => {
      expect(hasUnpushedCommits('')).toBe(false)
      expect(hasUnpushedCommits('   \n')).toBe(false)
    })
  })

  describe('shouldWarnUnpushed', () => {
    it('warns on a nonzero exit code even with clean output (no upstream set)', () => {
      expect(shouldWarnUnpushed(128, '')).toBe(true)
    })
    it('warns on a null exit code (the process never ran to completion)', () => {
      expect(shouldWarnUnpushed(null, '')).toBe(true)
    })
    it('warns on a clean exit with unpushed commits listed', () => {
      expect(shouldWarnUnpushed(0, 'abc123 wip\n')).toBe(true)
    })
    it('stays quiet on a clean exit with nothing ahead of upstream', () => {
      expect(shouldWarnUnpushed(0, '')).toBe(false)
      expect(shouldWarnUnpushed(0, '  \n')).toBe(false)
    })
  })
})
