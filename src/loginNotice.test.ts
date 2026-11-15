import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loginNotice } from './loginNotice.js';

describe('loginNotice', () => {
  it('does not call an admin read-only on a server that allows read-only visitors', () => {
    // signalk-server's loginStatus: readOnlyAccess mirrors the server's
    // "Allow Readonly Access" setting; userLevel is the login's own level.
    assert.equal(loginNotice({ status: 'loggedIn', readOnlyAccess: true, userLevel: 'admin', authenticationRequired: true }), 'none');
    assert.equal(loginNotice({ status: 'loggedIn', readOnlyAccess: true, userLevel: 'readwrite' }), 'none');
  });

  it('says read-only for a read-only login, whatever the server setting', () => {
    assert.equal(loginNotice({ status: 'loggedIn', readOnlyAccess: false, userLevel: 'readonly' }), 'read-only');
    assert.equal(loginNotice({ status: 'loggedIn', readOnlyAccess: true, userLevel: 'readonly' }), 'read-only');
  });

  it('asks to log in only where the server requires it', () => {
    assert.equal(loginNotice({ status: 'notLoggedIn', authenticationRequired: true, readOnlyAccess: true }), 'log-in');
    assert.equal(loginNotice({ status: 'notLoggedIn', authenticationRequired: false }), 'none');
    assert.equal(loginNotice(undefined), 'none');
  });
});
