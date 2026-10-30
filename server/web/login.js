'use strict';

const form = document.querySelector('#login-form');
const errorBox = document.querySelector('#login-error');

form.addEventListener('submit', async event => {
  event.preventDefault();
  errorBox.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  button.textContent = '登录中…';
  const data = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败');
    window.location.replace('/console.html');
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '登录工作台';
  }
});

fetch('/api/auth/demo').then(response => response.json()).then(result => {
  if (!result.enabled) return;
  const details = document.querySelector('#demo-accounts');
  for (const [role, username, password] of result.accounts) {
    const line = document.createElement('p');
    line.textContent = `${role}：${username} / ${password}`;
    details.appendChild(line);
  }
  const otp = document.createElement('p');
  otp.textContent = `确认操作的演示二次口令：${result.otp}`;
  details.appendChild(otp);
  details.hidden = false;
}).catch(() => {});
