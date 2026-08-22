import { initializeVoiceAssistant, shutdownVoiceAssistant } from './voice';

initializeVoiceAssistant();
window.addEventListener('beforeunload', shutdownVoiceAssistant);
