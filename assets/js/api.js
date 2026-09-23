/* Secret Santa - thin client for the mailbox API.
 *
 * The API stores ciphertext and nothing else. The auth secret proves you hold
 * one end of a mailbox; it is never derived from, and never reveals, a name.
 */
(function (global) {
  'use strict';

  function SantaApi(baseUrl) {
    this.base = String(baseUrl || '').replace(/\/+$/, '');
  }

  SantaApi.prototype.enabled = function () { return !!this.base; };

  SantaApi.prototype._request = function (method, path, secret, body) {
    var opts = {
      method: method,
      headers: { 'x-santa-auth': secret },
      mode: 'cors'
    };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(this.base + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
        if (!res.ok) {
          var err = new Error((payload && payload.error) || ('http_' + res.status));
          err.status = res.status;
          throw err;
        }
        return payload;
      });
    });
  };

  /** @returns {Promise<{wishlist: ?object, messages: Array}>} */
  SantaApi.prototype.getMailbox = function (id, secret) {
    return this._request('GET', '/m/' + encodeURIComponent(id), secret);
  };

  SantaApi.prototype.putWishlist = function (id, secret, ciphertext) {
    return this._request('PUT', '/m/' + encodeURIComponent(id) + '/wishlist', secret, { ct: ciphertext });
  };

  SantaApi.prototype.postMessage = function (id, secret, ciphertext) {
    return this._request('POST', '/m/' + encodeURIComponent(id) + '/messages', secret, { ct: ciphertext });
  };

  global.SantaApi = SantaApi;
})(window);
