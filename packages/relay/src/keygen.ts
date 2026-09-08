import { Store, defaultStorePath } from './store.ts';

// `npm run relay:keygen -- <device-name>` → prints a DEVICE_KEY (plaintext,
// shown once) and persists only its hash in the relay store.

const name = process.argv[2] ?? `windows-${new Date().toISOString().slice(0, 10)}`;
const path = defaultStorePath();
const store = await Store.load(path);
const { device, key } = await store.addDevice(name);

console.log('Device registered:');
console.log(`  name     : ${device.name}`);
console.log(`  deviceId : ${device.deviceId}`);
console.log(`  DEVICE_KEY: ${key}`);
console.log(`\nStore: ${path}`);
console.log('\nPut DEVICE_KEY in the agent config (~/.kremote/config.json):');
console.log(JSON.stringify({ relayUrl: 'wss://your-vps/ws', deviceKey: key }, null, 2));
console.log('\n⚠ This key is shown only once. The relay stores just its hash.');
