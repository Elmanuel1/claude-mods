import { expect, test } from 'claude-code/testing'
import { failureReason } from '../hooks/text'

const run = (stderr: string) => ({ stderr, stdout: '' })

test('a push rejected on a stale lease names the ref and the cause, not the generic summary', () => {
  const out = run([
    'To https://github.com/o/r.git',
    ' ! [rejected]            docs/updates -> docs/updates (stale info)',
    "error: failed to push some refs to 'https://github.com/o/r.git'",
  ].join('\n'))
  expect(failureReason(out)).toBe(
    '! [rejected]            docs/updates -> docs/updates (stale info): the remote branch moved since the last fetch (deleted after its PR merged, or pushed from elsewhere)',
  )
})

test('a protected branch is reported from the remote error line', () => {
  const out = run([
    'remote: error: GH006: Protected branch update failed for refs/heads/docs/updates.',
    'To https://github.com/o/r.git',
    ' ! [remote rejected] docs/updates -> docs/updates (protected branch hook declined)',
    "error: failed to push some refs to 'https://github.com/o/r.git'",
  ].join('\n'))
  expect(failureReason(out)).toBe('remote: error: GH006: Protected branch update failed for refs/heads/docs/updates.: the branch is protected on GitHub')
})

test('a fatal line wins over what follows it', () => {
  expect(failureReason(run("fatal: unable to access 'https://github.com/o/r.git/': 403\nhint: check your token"))).toBe(
    "fatal: unable to access 'https://github.com/o/r.git/': 403",
  )
})

test('output with no cause line falls back to its last line', () => {
  expect(failureReason({ stderr: '', stdout: 'one\ntwo' })).toBe('two')
})
