const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, sessions } = require('../src/server');

beforeEach(() => {
  sessions.clear();
});

function findUser(summary, uid) {
  const combined = [...summary.active, ...summary.idle];
  return combined.find((entry) => entry.uid === uid) || null;
}

test('presence summary combines paths across client sessions and reflects tab closures', async () => {
  const agent = request(app);
  const uid = 'user-123';

  const sessionsToOpen = [
    { uid, path: '/test', clientId: 'client-a' },
    { uid, path: 'Test/', clientId: 'client-b' },
    { uid, path: ' /tette/ ', clientId: 'client-c' },
  ];

  for (const payload of sessionsToOpen) {
    await agent.post('/presence/ping').send(payload).expect(200);
  }

  const summaryAfterOpen = await agent.get('/presence/summary').expect(200);
  const userAfterOpen = findUser(summaryAfterOpen.body, uid);
  assert(userAfterOpen, 'expected user to appear after opening multiple tabs');
  assert.deepEqual(userAfterOpen.paths, ['/test', '/tette']);

  await agent
    .post('/presence/leave')
    .send({ uid, clientId: 'client-c' })
    .expect(200);

  const summaryAfterClosingTette = await agent.get('/presence/summary').expect(200);
  const userAfterClosingTette = findUser(summaryAfterClosingTette.body, uid);
  assert(userAfterClosingTette, 'expected user to remain after closing /tette tab');
  assert.deepEqual(userAfterClosingTette.paths, ['/test']);

  await agent
    .post('/presence/leave')
    .send({ uid, clientId: 'client-a' })
    .expect(200);

  const summaryAfterClosingOneTest = await agent.get('/presence/summary').expect(200);
  const userAfterClosingOneTest = findUser(summaryAfterClosingOneTest.body, uid);
  assert(userAfterClosingOneTest, 'expected one /test tab to keep the user visible');
  assert.deepEqual(userAfterClosingOneTest.paths, ['/test']);

  await agent
    .post('/presence/leave')
    .send({ uid, clientId: 'client-b' })
    .expect(200);

  const summaryAfterClosingAll = await agent.get('/presence/summary').expect(200);
  const userAfterClosingAll = findUser(summaryAfterClosingAll.body, uid);
  assert.equal(userAfterClosingAll, null, 'expected user to be removed after closing all tabs');
  assert.equal(
    summaryAfterClosingAll.body.active.length + summaryAfterClosingAll.body.idle.length,
    0,
  );
});
