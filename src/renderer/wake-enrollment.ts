export {};

type EnrollmentUpdate = {
  state: 'idle' | 'ready' | 'listening' | 'captured' | 'complete' | 'error';
  captured: number;
  required: number;
  message: string;
};

const statusElement = document.querySelector<HTMLElement>('#status');
const count = document.querySelector<HTMLElement>('#count');
const recordButton = document.querySelector<HTMLButtonElement>('#record');
const closeButton = document.querySelector<HTMLButtonElement>('#close');

function render(update: EnrollmentUpdate) {
  if (statusElement) statusElement.textContent = update.message;
  if (count) count.textContent = `${update.captured} / ${update.required}`;
  if (recordButton) {
    recordButton.disabled = !['ready', 'captured'].includes(update.state);
    recordButton.textContent = update.state === 'listening' ? '正在听，请说…' : '录入下一次';
  }
}

window.jarvis.onWakeEnrollmentUpdate(render);
recordButton?.addEventListener('click', () => window.jarvis.wakeEnrollmentCommand('capture'));
closeButton?.addEventListener('click', () => window.close());
window.jarvis.wakeEnrollmentCommand('start');
