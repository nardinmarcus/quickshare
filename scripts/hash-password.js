const { hashSecret } = require('../utils/security');

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error('Usage: npm run hash-password -- "your-password"');
    process.exit(1);
  }

  const hash = await hashSecret(password);
  process.stdout.write(`${hash}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
