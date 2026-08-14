#!/usr/bin/env node
// Emits the update-receipt JSON that scripts/update.sh drops into $IRISES_HOME. Reads the commit
// summary (`git log --oneline old..new`, one commit per line) on stdin and takes old/new sha + branch
// as argv. Kept as a tiny node helper rather than inline bash so the JSON is escaped safely and is
// unit-testable (scripts/write-update-receipt.test.ts).
//
//   git log --oneline OLD..NEW | node scripts/write-update-receipt.js OLD NEW BRANCH > $IRISES_HOME/update-receipt.json

const [oldSha = '', newSha = '', branch = ''] = process.argv.slice(2);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const changes = input.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 50);
  const receipt = {
    oldSha,
    newSha,
    ...(branch ? { branch } : {}),
    appliedAt: new Date().toISOString(),
    changes,
  };
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
});
