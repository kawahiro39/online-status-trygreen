const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, sessions, tombstones, constants } = require('../src/server');

beforeEach(() => {
  sessions.clear();
  tombstones.clear();
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
    const response = await agent.post('/presence/ping').send(payload).expect(200);
    assert.equal(response.body.ok, true);
  }

  const summaryAfterOpen = await agent.get('/presence/summary').expect(200);
  const userAfterOpen = findUser(summaryAfterOpen.body, uid);
  assert(userAfterOpen, 'expected user to appear after opening multiple tabs');
  assert.deepEqual(userAfterOpen.paths, ['/test', '/tette']);

  const leaveTette = await agent
    .post('/presence/leave')
    .send({ uid, clientId: 'client-c' })
    .expect(200);
  assert.equal(leaveTette.body.ok, true);
  assert.equal(leaveTette.body.deleted, 1);

  const summaryAfterClosingTette = await agent.get('/presence/summary').expect(200);
  const userAfterClosingTette = findUser(summaryAfterClosingTette.body, uid);
  assert(userAfterClosingTette, 'expected user to remain after closing /tette tab');
  assert.deepEqual(userAfterClosingTette.paths, ['/test']);

  const leaveClientA = await agent
    .post('/presence/leave')
    .send({ uid, clientId: 'client-a' })
    .expect(200);
  assert.equal(leaveClientA.body.ok, true);

  const summaryAfterClosingOneTest = await agent.get('/presence/summary').expect(200);
  const userAfterClosingOneTest = findUser(summaryAfterClosingOneTest.body, uid);
  assert(userAfterClosingOneTest, 'expected one /test tab to keep the user visible');
  assert.deepEqual(userAfterClosingOneTest.paths, ['/test']);

  const leaveClientB = await agent
    .post('/presence/leave')
    .send({ uid, clientId: 'client-b' })
    .expect(200);
  assert.equal(leaveClientB.body.ok, true);

  const summaryAfterClosingAll = await agent.get('/presence/summary').expect(200);
  const userAfterClosingAll = findUser(summaryAfterClosingAll.body, uid);
  assert.equal(userAfterClosingAll, null, 'expected user to be removed after closing all tabs');
  assert.equal(
    summaryAfterClosingAll.body.active.length + summaryAfterClosingAll.body.idle.length,
    0,
  );
});

test('presence ping replaces the current path for the same client', async () => {
  const agent = request(app);
  const uid = 'user-xyz';
  const clientId = 'client-tab';

  const first = await agent
    .post('/presence/ping')
    .send({ uid, clientId, path: '/alpha?tab=one' })
    .expect(200);
  assert.equal(first.body.ok, true);

  const second = await agent
    .post('/presence/ping')
    .send({ uid, clientId, path: '/alpha?tab=two' })
    .expect(200);
  assert.equal(second.body.ok, true);

  const summary = await agent.get('/presence/summary').expect(200);
  const user = findUser(summary.body, uid);
  assert(user, 'user should be present after updating the tab');
  assert.deepEqual(user.paths, ['/alpha?tab=two']);
});

test('presence ignores tombstoned clients until the tombstone expires', async () => {
  const agent = request(app);
  const uid = 'user-tombstone';
  const clientId = 'client-tombstone';

  const openResponse = await agent
    .post('/presence/ping')
    .send({ uid, clientId, path: '/beta' })
    .expect(200);
  assert.equal(openResponse.body.ok, true);

  const leaveResponse = await agent
    .post('/presence/leave')
    .send({ uid, clientId })
    .expect(200);
  assert.equal(leaveResponse.body.deleted, 1);

  const tombstonedResponse = await agent
    .post('/presence/ping')
    .send({ uid, clientId, path: '/beta?tab=new' })
    .expect(200);
  assert.equal(tombstonedResponse.body.ignored, 'tombstoned');

  let summary = await agent.get('/presence/summary').expect(200);
  const userDuringTombstone = findUser(summary.body, uid);
  assert.equal(userDuringTombstone, null, 'user should be absent while tombstoned');

  const originalDateNow = Date.now;
  const advanceMs = constants.TOMBSTONE_MS + 1;
  try {
    const base = originalDateNow();
    Date.now = () => base + advanceMs;
    const revivedResponse = await agent
      .post('/presence/ping')
      .send({ uid, clientId, path: '/beta?tab=revived' })
      .expect(200);
    assert.equal(revivedResponse.body.ok, true);
  } finally {
    Date.now = originalDateNow;
  }

  summary = await agent.get('/presence/summary').expect(200);
  const userAfterTombstone = findUser(summary.body, uid);
  assert(userAfterTombstone, 'user should reappear after tombstone expiry');
  assert.deepEqual(userAfterTombstone.paths, ['/beta?tab=revived']);
});

test('presence transitions to idle when only pings are received', async () => {
  const agent = request(app);
  const uid = 'user-idle';
  const clientId = 'client-idle';

  const originalDateNow = Date.now;
  try {
    let now = originalDateNow();
    Date.now = () => now;

    const firstPing = await agent
      .post('/presence/ping')
      .send({ uid, clientId, path: '/idle' })
      .expect(200);
    assert.equal(firstPing.body.ok, true);

    let summary = await agent.get('/presence/summary').expect(200);
    assert.equal(summary.body.active.length, 1);
    assert.equal(summary.body.idle.length, 0);

    now += constants.ACTIVE_MS + 1;

    const keepAlivePing = await agent
      .post('/presence/ping')
      .send({ uid, clientId, path: '/idle' })
      .expect(200);
    assert.equal(keepAlivePing.body.ok, true);

    summary = await agent.get('/presence/summary').expect(200);
    assert.equal(summary.body.active.length, 0);
    assert.equal(summary.body.idle.length, 1);
    assert.equal(summary.body.idle[0].uid, uid);
    assert.deepEqual(summary.body.idle[0].paths, ['/idle']);
  } finally {
    Date.now = originalDateNow;
  }
});
