const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');

let browser;
let socket;

beforeEach(() => {
  const viewsDirectory = path.resolve(__dirname, '../result/views');

  const html = fs.readFileSync(
    path.join(viewsDirectory, 'index.html'),
    'utf8'
  );

  browser = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost'
  });

  // Start Angular manually once for predictable test setup.
  const root = browser.window.document.documentElement;

  expect(root.getAttribute('ng-app')).toBe('catsvsdogs');
  root.removeAttribute('ng-app');

  // Simulate events arriving through Socket.IO.
  socket = new EventEmitter();

  browser.window.io = {
    connect: () => socket
  };

  // Load the actual application's Angular library and controller.
  for (const filename of ['angular.min.js', 'app.js']) {
    const source = fs.readFileSync(
      path.join(viewsDirectory, filename),
      'utf8'
    );

    browser.window.eval(source);
  }

  browser.window.angular.bootstrap(
    browser.window.document,
    ['catsvsdogs']
  );
});

afterEach(() => {
  if (browser) {
    browser.window.close();
    browser = undefined;
  }
});

test('frontend displays valid scores received through the socket', () => {
  socket.emit('scores', JSON.stringify({ a: 3, b: 1 }));

  const document = browser.window.document;

  const percentages = Array.from(
    document.querySelectorAll('.stat'),
    element => element.textContent.trim()
  );

  expect(percentages).toEqual(['75.0%', '25.0%']);
  expect(document.body.textContent).toContain('4 votes');

  expect(document.body.textContent).not.toContain(
    'Results currently unavailable'
  );
});

test('frontend shows unavailable and removes old scores after failure', () => {
  // First display a healthy result.
  socket.emit('scores', JSON.stringify({ a: 3, b: 1 }));

  const document = browser.window.document;

  expect(document.querySelectorAll('.stat')).toHaveLength(2);
  expect(document.body.textContent).toContain('4 votes');

  // Then simulate the backend's failure notification.
  socket.emit('db-unavailable');

  expect(document.body.textContent).toContain(
    'Results currently unavailable'
  );

  expect(document.querySelectorAll('.stat')).toHaveLength(0);
  expect(document.body.textContent).not.toContain('4 votes');
});