/**
 * HiFi Messaging - Capacitor Native Plugin Integrations
 * Intercepts standard web behavior and wraps them in native Capacitor APIs 
 * when running inside a native iOS or Android app context.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Check if running in a native Capacitor platform
  const isNative = window.Capacitor && window.Capacitor.isNativePlatform();
  
  if (isNative) {
    console.log('[Capacitor Integration] Native environment detected. Activating native integrations...');
    document.body.classList.add('native-app');
    const platform = (window.Capacitor && window.Capacitor.getPlatform) ? window.Capacitor.getPlatform() : '';
    if (platform === 'android' || /android/i.test(navigator.userAgent)) {
      document.body.classList.add('platform-android');
    }
    initCapacitorIntegrations();
  } else {
    console.log('[Capacitor Integration] Standard browser environment. Native integrations disabled.');
  }
});

function initCapacitorIntegrations() {
  const { Camera, Geolocation, LocalNotifications, Filesystem, VoiceRecorder, App } = window.Capacitor.Plugins;

  // Helper to clone and replace an element, returning the active DOM element
  function recreateElement(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    return clone;
  }

  // ==========================================
  // 1. MOBILE BACK BUTTON HANDLER
  // ==========================================
  if (App) {
    console.log('[Capacitor] Initializing Mobile Back Button Handler...');
    App.addListener('backButton', () => {
      // 1. Close any open light overlay (seen-by popup, report modal,
      //    bug/feature/poll forms, appeal form, emoji picker, ...) that is NOT
      //    tracked in the Nav stack. Without this the back gesture ignored
      //    them (and could even exit the app while one was open).
      if (typeof window.closeTopOverlay === 'function' && window.closeTopOverlay()) {
        return;
      }
      // 2. Pop the Nav stack (chats, panels, Nav-registered modals).
      if (window.Nav && window.Nav.stack && window.Nav.stack.length > 0) {
        window.Nav.back();
        return;
      }
      // 3. Root screen reached — exit the app.
      console.log('[Capacitor] Root screen reached. Exiting app...');
      App.exitApp();
    });
  }

  // ==========================================
  // 2. LOCAL PUSH NOTIFICATIONS (ANDROID STATUS BAR)
  // ==========================================
  if (LocalNotifications) {
    console.log('[Capacitor] Initializing Local Notifications & High-Importance Channel...');

    // 1. Create Android Notification Channel (Required for Android 8.0+ Status Bar Notifications)
    LocalNotifications.createChannel({
      id: 'hifi_messages_channel',
      name: 'Message Notifications',
      description: 'Incoming message alerts for HiFi Messaging',
      importance: 5, // High importance (5) = banner pop-up + sound + status bar icon
      visibility: 1, // Public on lockscreen
      vibration: true
    }).then(() => {
      console.log('[Capacitor] Notification channel created successfully');
    }).catch(err => {
      console.warn('[Capacitor] Channel creation notice:', err);
    });

    // 2. Request permission on start (Required for Android 13+)
    LocalNotifications.requestPermissions().then(result => {
      console.log('[Capacitor] Notification permission result:', result.display);
    }).catch(() => {});

    // Override global notification permission requester
    window.requestNotificationPermission = async function() {
      try {
        const check = await LocalNotifications.checkPermissions();
        if (check.display !== 'granted') {
          const res = await LocalNotifications.requestPermissions();
          return res.display === 'granted';
        }
        return true;
      } catch (e) {
        return false;
      }
    };

    // Override global push notification dispatcher
    window.sendPushNotification = async function(title, body, tag) {
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.getPlatform() === 'android') {
        // Native HiFiBackgroundService handles all Android notifications with Avatar & Inline Reply
        return;
      }
      try {
        const perm = await LocalNotifications.checkPermissions();
        if (perm.display !== 'granted') {
          const req = await LocalNotifications.requestPermissions();
          if (req.display !== 'granted') return;
        }

        const notifId = Math.floor(Math.random() * 900000) + 100000;
        await LocalNotifications.schedule({
          notifications: [
            {
              title: String(title || 'HiFi Messaging'),
              body: String(body || 'New message received'),
              id: notifId,
              channelId: 'hifi_messages_channel',
              schedule: { at: new Date(Date.now() + 500) },
              extra: { tag }
            }
          ]
        });
        console.log('[Capacitor] Scheduled Android status bar notification:', title, body);
      } catch (err) {
        console.error('[Capacitor] Failed to schedule local notification:', err);
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification(title, { body, tag }); } catch(e) {}
        }
      }
    };
  }

  // Helper to compress base64 dataUrl (from native Camera) using Canvas
  function compressDataUrl(dataUrl, maxWidth = 1280, maxHeight = 1280, quality = 0.75) {
    return new Promise((resolve) => {
      if (!dataUrl) return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          if (width / height > maxWidth / maxHeight) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressed = canvas.toDataURL('image/jpeg', quality);
        resolve(compressed);
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // ==========================================
  // 3. NATIVE CAMERA / PHOTO SELECTOR
  // ==========================================
  const attachBtn = recreateElement('attachBtn');
  if (attachBtn && Camera) {
    console.log('[Capacitor] Overriding attachBtn for native Camera...');
    
    attachBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const overflowMenu = document.getElementById('overflowMenu');
      if (overflowMenu) overflowMenu.classList.remove('show');

      try {
        const photo = await Camera.getPhoto({
          quality: 85,
          width: 1280,
          allowEditing: false,
          resultType: 'dataUrl', // Returns standard base64 data URL
          source: 'Prompt' // Prompts for Camera or Photos gallery
        });

        // Use global variables directly to resolve lexical scoping issues
        const chat = typeof activeChat !== 'undefined' ? activeChat : null;
        const user = typeof currentUser !== 'undefined' ? currentUser : null;
        const sock = typeof socket !== 'undefined' ? socket : null;

        if (photo && photo.dataUrl && chat && sock && user) {
          const compressedUrl = await compressDataUrl(photo.dataUrl);

          if (chat.type === 'dm') {
            sock.emit('send_message', {
              from: user.id,
              to: chat.id,
              text: '',
              type: 'image',
              mediaUrl: compressedUrl
            });
          } else {
            sock.emit('send_group_message', {
              from: user.id,
              groupId: chat.id,
              text: '',
              type: 'image',
              mediaUrl: compressedUrl
            });
          }
        } else {
          console.warn('[Capacitor] Cannot send photo: missing activeChat, socket, or currentUser.', { chat, user, sock: !!sock });
        }
      } catch (err) {
        console.log('[Capacitor] Camera action cancelled or failed:', err);
      }
    });
  }

  // ==========================================
  // 4. GPS GEOLOCATION
  // ==========================================
  const locationBtn = recreateElement('locationBtn');
  if (locationBtn && Geolocation) {
    console.log('[Capacitor] Overriding locationBtn for native Geolocation...');
    
    locationBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        if (typeof window.showToast === 'function') {
          window.showToast('Fetching GPS coordinates...', 'info');
        }

        const position = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10000
        });

        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;

        const chat = typeof activeChat !== 'undefined' ? activeChat : null;
        const user = typeof currentUser !== 'undefined' ? currentUser : null;
        const sock = typeof socket !== 'undefined' ? socket : null;

        if (chat && sock && user) {
          if (chat.type === 'dm') {
            sock.emit('send_message', {
              from: user.id,
              to: chat.id,
              text: '📍 My Location',
              type: 'location',
              mediaUrl: mapsUrl
            });
          } else {
            sock.emit('send_group_message', {
              from: user.id,
              groupId: chat.id,
              text: '📍 My Location',
              type: 'location',
              mediaUrl: mapsUrl
            });
          }
        }
      } catch (err) {
        console.error('[Capacitor] Geolocation error:', err);
        if (typeof window.showToast === 'function') {
          window.showToast('Failed to get GPS location', 'error');
        }
      }
    });
  }

  // ==========================================
  // 5. NATIVE MICROPHONE / AUDIO RECORDER
  // ==========================================
  const startRecordBtn = recreateElement('startRecordBtn');
  const stopRecordBtn = recreateElement('stopRecordBtn');
  const sendVoiceBtn = recreateElement('sendVoiceBtn');
  const cancelVoiceBtn = recreateElement('cancelVoiceBtn');
  const voiceTimer = document.getElementById('voiceTimer');

  let isAnimatingWave = false;

  function animateDummyWave() {
    const canvas = document.getElementById('voiceCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    isAnimatingWave = true;

    function draw() {
      if (!isAnimatingWave) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      requestAnimationFrame(draw);
      ctx.fillStyle = '#0b0e11'; // Purple Nebula dark body background color
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#38bdf8'; // Premium sky blue color for active wave
      ctx.beginPath();
      
      const sliceWidth = canvas.width / 40;
      let x = 0;
      ctx.moveTo(0, canvas.height / 2);
      for (let i = 0; i <= 40; i++) {
        const rand = Math.random() * 0.75 + 0.25;
        const y = (canvas.height / 2) + (Math.sin(x * 0.05 + Date.now() * 0.015) * (canvas.height / 3) * rand);
        ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
    }
    draw();
  }

  // Overridden functions to manipulate active DOM elements and clean native state
  window.closeVoiceRecorder = function() {
    const voiceRecorderOverlay = document.getElementById('voiceRecorderOverlay');
    if (voiceRecorderOverlay) voiceRecorderOverlay.classList.remove('show');
    
    isAnimatingWave = false;
    clearInterval(window.recordingTimer);

    if (VoiceRecorder) {
      VoiceRecorder.stopRecording().catch(() => {});
    }
    
    window.resetVoiceRecorder();
  };

  window.resetVoiceRecorder = function() {
    window.recordedVoiceBase64 = null;
    window.recordedVoiceMimeType = null;
    window.recordingSeconds = 0;
    
    if (voiceTimer) voiceTimer.textContent = '0:00';
    
    if (startRecordBtn) startRecordBtn.style.display = 'inline-block';
    if (stopRecordBtn) stopRecordBtn.style.display = 'none';
    if (sendVoiceBtn) sendVoiceBtn.style.display = 'none';
    if (cancelVoiceBtn) cancelVoiceBtn.style.display = 'none';
    
    const canvas = document.getElementById('voiceCanvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  if (VoiceRecorder && startRecordBtn && stopRecordBtn && sendVoiceBtn && cancelVoiceBtn) {
    console.log('[Capacitor] Overriding voice recorder for native VoiceRecorder...');

    // 5a. Start Recording Override
    startRecordBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        const checkPermission = await VoiceRecorder.requestAudioRecordingPermission();
        if (!checkPermission.value) {
          if (typeof window.showToast === 'function') {
            window.showToast('Microphone permission denied', 'error');
          }
          return;
        }

        await VoiceRecorder.startRecording();
        console.log('[Capacitor] Native audio recording started.');

        // Update UI using active references
        startRecordBtn.style.display = 'none';
        stopRecordBtn.style.display = 'inline-block';
        cancelVoiceBtn.style.display = 'inline-block';

        window.recordingSeconds = 0;
        if (voiceTimer) voiceTimer.textContent = '0:00';

        window.recordingTimer = setInterval(() => {
          window.recordingSeconds++;
          const m = Math.floor(window.recordingSeconds / 60);
          const s = window.recordingSeconds % 60;
          if (voiceTimer) voiceTimer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }, 1000);

        animateDummyWave();
      } catch (err) {
        console.error('[Capacitor] Failed to start native recording:', err);
        if (typeof window.showToast === 'function') {
          window.showToast('Audio recording failed to start', 'error');
        }
      }
    });

    // 5b. Stop Recording Override
    stopRecordBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        const result = await VoiceRecorder.stopRecording();
        console.log('[Capacitor] Native audio recording stopped.', result);

        clearInterval(window.recordingTimer);
        isAnimatingWave = false;

        // Note: result.value holds the RecordingData object in capacitor-voice-recorder
        if (result && result.value && result.value.recordDataBase64) {
          window.recordedVoiceBase64 = result.value.recordDataBase64;
          window.recordedVoiceMimeType = result.value.mimeType || 'audio/aac';
          
          stopRecordBtn.style.display = 'none';
          sendVoiceBtn.style.display = 'inline-block';
          cancelVoiceBtn.style.display = 'inline-block';
        } else {
          if (typeof window.showToast === 'function') {
            window.showToast('Recording failed or empty', 'error');
          }
          window.closeVoiceRecorder();
        }
      } catch (err) {
        console.error('[Capacitor] Failed to stop native recording:', err);
        isAnimatingWave = false;
        clearInterval(window.recordingTimer);
        window.closeVoiceRecorder();
      }
    });

    // 5c. Send Voice Message Override
    sendVoiceBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const chat = typeof activeChat !== 'undefined' ? activeChat : null;
      const user = typeof currentUser !== 'undefined' ? currentUser : null;
      const sock = typeof socket !== 'undefined' ? socket : null;

      if (!window.recordedVoiceBase64 || !chat || !sock || !user) {
        console.warn('[Capacitor] Cannot send voice message: missing activeChat, socket, or currentUser.', { chat, user, sock: !!sock });
        return;
      }

      const audioDataUrl = `data:${window.recordedVoiceMimeType};base64,${window.recordedVoiceBase64}`;

      if (chat.type === 'dm') {
        sock.emit('send_message', {
          from: user.id,
          to: chat.id,
          text: '',
          type: 'voice',
          mediaUrl: audioDataUrl,
          duration: window.recordingSeconds
        });
      } else {
        sock.emit('send_group_message', {
          from: user.id,
          groupId: chat.id,
          text: '',
          type: 'voice',
          mediaUrl: audioDataUrl,
          duration: window.recordingSeconds
        });
      }

      window.closeVoiceRecorder();
      if (typeof window.showToast === 'function') {
        window.showToast('Voice message sent!', 'success');
      }
    });

    // 5d. Cancel Recording Override
    cancelVoiceBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      isAnimatingWave = false;
      clearInterval(window.recordingTimer);

      try {
        await VoiceRecorder.stopRecording();
      } catch (err) {
        // Ignore if recorder not running
      }

      window.closeVoiceRecorder();
    });
  }

  // ==========================================
  // 6. LOCAL DEVICE FILESYSTEM STORAGE
  // ==========================================
  const lightboxSaveBtn = document.getElementById('lightboxSaveBtn');
  if (lightboxSaveBtn && Filesystem) {
    console.log('[Capacitor] Binding Filesystem Save Button in Lightbox...');

    lightboxSaveBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const img = document.getElementById('lightboxImage');
      if (!img || !img.src) {
        if (typeof window.showToast === 'function') {
          window.showToast('No image preview found', 'error');
        }
        return;
      }

      try {
        if (typeof window.showToast === 'function') {
          window.showToast('Saving image to local storage...', 'info');
        }

        let src = img.src;
        let base64Data = '';
        let mimeType = 'image/png';

        if (src.startsWith('data:')) {
          const parts = src.split(',');
          mimeType = parts[0].split(';')[0].split(':')[1] || 'image/png';
          base64Data = parts[1];
        } else {
          // Download HTTP URL and convert to base64
          const downloadUrl = async (url) => {
            const response = await fetch(url);
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          };
          const dataUrl = await downloadUrl(src);
          const parts = dataUrl.split(',');
          mimeType = parts[0].split(';')[0].split(':')[1] || 'image/png';
          base64Data = parts[1];
        }

        const extension = mimeType.split('/')[1] || 'png';
        const fileName = `HiFi_Message_${Date.now()}.${extension}`;

        await Filesystem.requestPermissions();

        const result = await Filesystem.writeFile({
          path: fileName,
          data: base64Data,
          directory: 'Documents'
        });

        console.log('[Capacitor] Image written successfully:', result.uri);
        if (typeof window.showToast === 'function') {
          window.showToast(`Saved to Documents/${fileName}`, 'success');
        }
      } catch (err) {
        console.error('[Capacitor] Failed to save image to filesystem:', err);
        if (typeof window.showToast === 'function') {
          window.showToast('Failed to save to device storage', 'error');
        }
      }
    });
  }
}
