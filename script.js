(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ------- СОСТОЯНИЕ -------
  let notes = [];
  try {
    notes = JSON.parse(localStorage.getItem('notes_v1') || '[]');
    if (!Array.isArray(notes)) notes = [];
  } catch (e) {
    notes = [];
  }

  let recognizing = false;
  let finalText = '';
  let interimText = '';
  let currentScreen = 'recorderScreen';
  let currentNoteId = null;
  let model = null;
  let recognizer = null;
  let audioContext = null;
  let mediaStream = null;
  let recognizerNode = null;
  let sourceNode = null;

  // WebLLM
  let engine = null;
  let webllmReady = false;
  let webllmModule = null;

  // ------- ЭЛЕМЕНТЫ -------
  const navBtn = $('navBtn');
  const recordBtn = $('recordBtn');
  const recordIcon = $('recordIcon');
  const saveBtn = $('saveBtn');
  const statusEl = $('status');
  const transcriptEl = $('transcript');
  const notesList = $('notesList');
  const noteTitle = $('noteTitle');
  const noteDate = $('noteDate');
  const noteContent = $('noteContent');
  const backBtn = $('backBtn');
  const copyNoteBtn = $('copyNoteBtn');
  const deleteNoteBtn = $('deleteNoteBtn');

  // ============================================================
  //  ЗАГРУЗКА МОДЕЛИ VOSK
  // ============================================================
  async function loadVoskModel() {
    statusEl.textContent = 'Загрузка модели распознавания (первый раз ~50 МБ)...';

    try {
      const modelUrl = 'models/vosk-model-small-ru-0.22.zip';
      model = await Vosk.createModel(modelUrl);
      recognizer = new model.KaldiRecognizer(16000);

      recognizer.on('result', (message) => {
        const text = message.result.text;
        if (text) {
          finalText += text + ' ';
          interimText = '';
          renderTranscript();
        }
      });

      recognizer.on('partialresult', (message) => {
        interimText = message.result.partial;
        renderTranscript();
      });

      statusEl.textContent = 'Распознавание готово';
      recordBtn.disabled = false;
    } catch (err) {
      console.error('Ошибка загрузки модели Vosk:', err);
      statusEl.textContent = 'Ошибка загрузки модели';
      alert('Не удалось загрузить модель распознавания. Проверьте, что файл модели лежит в папке models/.');
    }
  }

  // ============================================================
  //  ИНИЦИАЛИЗАЦИЯ WEBLLM (ИИ В БРАУЗЕРЕ)
  // ============================================================
  async function initWebLLM() {
    if (!navigator.gpu) {
      statusEl.textContent = 'ИИ не поддерживается на этом телефоне';
      console.warn('WebGPU not available');
      return;
    }

    const cdns = [
      'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm',
      'https://esm.run/@mlc-ai/web-llm@0.2.79',
      'https://unpkg.com/@mlc-ai/web-llm@0.2.79/dist/index.js'
    ];

    for (let i = 0; i < cdns.length; i++) {
      try {
        statusEl.textContent = 'Загрузка ИИ (CDN ' + (i + 1) + ')...';
        console.log('Пробуем CDN:', cdns[i]);

        webllmModule = await import(cdns[i]);

        // Qwen 2.5 3B — заметно лучше понимает русский, чем Llama
        const selectedModel = 'Qwen2.5-3B-Instruct-q4f16_1-MLC';

        statusEl.textContent = 'Загрузка модели ИИ (~1.9 ГБ)...';
        engine = await webllmModule.CreateMLCEngine(selectedModel, {
          initProgressCallback: (progress) => {
            const pct = Math.round(progress.progress * 100);
            statusEl.textContent = 'Загрузка ИИ: ' + pct + '%';
          }
        });

        webllmReady = true;
        statusEl.textContent = 'ИИ готов к работе';
        console.log('WebLLM ready via', cdns[i]);
        return;
      } catch (err) {
        console.warn('CDN ' + (i + 1) + ' не сработал:', err.message);
      }
    }

    statusEl.textContent = 'ИИ не загрузился (будет локальная обработка)';
    console.error('Все CDN WebLLM недоступны');
  }

  // ============================================================
  //  НАВИГАЦИЯ
  // ============================================================
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
    currentScreen = id;
    navBtn.textContent = id === 'recorderScreen' ? 'Конспекты' : 'Запись';
    if (id === 'notesScreen') renderNotes();
    window.scrollTo(0, 0);
  }

  navBtn.addEventListener('click', () => {
    if (currentScreen === 'recorderScreen') showScreen('notesScreen');
    else showScreen('recorderScreen');
  });

  backBtn.addEventListener('click', () => showScreen('notesScreen'));

  // ============================================================
  //  UI
  // ============================================================
  function updateRecordUI() {
if (recognizing) {
  recordIcon.className = 'fa-solid fa-stop';
  recordBtn.classList.add('recording');
  statusEl.textContent = '● Идёт запись';
} else {
  recordIcon.className = 'fa-solid fa-microphone';
  recordBtn.classList.remove('recording');
      if (model && webllmReady) statusEl.textContent = 'Готов к записи';
      else if (model) statusEl.textContent = 'Распознавание готово';
    }
  }

  function renderTranscript() {
    const full = (finalText + ' ' + interimText).trim();
    if (!full) {
      const msg = recognizing ? 'Слушаю...' : 'Нажмите кнопку и говорите...';
      transcriptEl.innerHTML = '<span class="placeholder">' + msg + '</span>';
      return;
    }
    transcriptEl.textContent = finalText + (interimText ? ' ' + interimText : '');
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  // ============================================================
  //  ЗАПИСЬ + РАСПОЗНАВАНИЕ (Vosk)
  // ============================================================
  async function startRecording() {
    if (!model || !recognizer) {
      alert('Модель ещё загружается. Подождите.');
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1
        }
      });

      audioContext = new AudioContext();
      const nativeRate = audioContext.sampleRate;
      const targetRate = 16000;

      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      recognizerNode = audioContext.createScriptProcessor(4096, 1, 1);

      recognizerNode.onaudioprocess = (event) => {
        if (!recognizing) return;
        try {
          const inputBuffer = event.inputBuffer;
          if (nativeRate === targetRate) {
            recognizer.acceptWaveform(inputBuffer);
          } else {
            const resampled = resampleBuffer(inputBuffer, targetRate);
            recognizer.acceptWaveform(resampled);
          }
        } catch (error) {
          console.error('acceptWaveform failed:', error);
        }
      };

      sourceNode.connect(recognizerNode);
      recognizerNode.connect(audioContext.destination);

      recognizing = true;
      finalText = '';
      interimText = '';
      renderTranscript();
      saveBtn.hidden = true;
      updateRecordUI();
    } catch (err) {
      alert('Нет доступа к микрофону: ' + (err.message || err));
    }
  }

  function resampleBuffer(inputBuffer, targetRate) {
    const inputData = inputBuffer.getChannelData(0);
    const inputRate = inputBuffer.sampleRate;

    const ratio = inputRate / targetRate;
    const outputLength = Math.floor(inputData.length / ratio);
    const outputData = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1);
      const t = srcIndex - srcIndexFloor;
      outputData[i] = inputData[srcIndexFloor] * (1 - t) + inputData[srcIndexCeil] * t;
    }

    const outBuffer = audioContext.createBuffer(1, outputLength, targetRate);
    outBuffer.copyToChannel(outputData, 0);
    return outBuffer;
  }

  function stopRecording() {
    recognizing = false;

    if (recognizerNode) {
      recognizerNode.disconnect();
      recognizerNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    updateRecordUI();
    const hasText = (finalText + interimText).trim().length > 0;
    saveBtn.hidden = !hasText;
    statusEl.textContent = hasText ? 'Распознано' : 'Ничего не распознано';
  }

  recordBtn.addEventListener('click', () => {
    if (recognizing) stopRecording();
    else startRecording();
  });

  // ============================================================
  //  СОЗДАНИЕ КОНСПЕКТА
  // ============================================================
  saveBtn.addEventListener('click', async () => {
    const text = (finalText + ' ' + interimText).trim();
    if (!text) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Обработка...';
    statusEl.textContent = 'ИИ делает конспект...';

    let summary;
    try {
      summary = await summarizeWithWebLLM(text);
    } catch (e) {
      console.warn('WebLLM недоступен, локальная обработка:', e);
      summary = localSummarize(text);
    }

    const note = {
      id: Date.now(),
      date: new Date().toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }),
      title: summary.title || 'Конспект',
      content: summary.content || text
    };

    notes.unshift(note);
    saveNotes();

    saveBtn.disabled = false;
    saveBtn.textContent = 'Сделать конспект';
    saveBtn.hidden = true;
    statusEl.textContent = 'Конспект сохранён';
    finalText = '';
    interimText = '';
    renderTranscript();
    openNote(note.id);
  });

  // ============================================================
  //  ГЕНЕРАЦИЯ КОНСПЕКТА ЧЕРЕЗ WEBLLM
  // ============================================================
async function summarizeWithWebLLM(rawText) {
  if (!webllmReady || !engine) {
    throw new Error('WebLLM не готов');
  }

  if (rawText.trim().length < 80) {
    return localSummarize(rawText);
  }

  // ЗАПРОС 1: только заголовок
  let title = '';
  try {
    const titlePrompt =
      'Прочитай текст и определи, О ЧЁМ ОН. Ответь ОДНОЙ короткой фразой из 3-5 слов.\n' +
      'Без кавычек, без скобок, без точки в конце, без пояснений.\n' +
      'Только сама фраза — и всё. Не пиши "Заголовок:", не пиши "Ответ:".\n\n' +
      'ТЕКСТ:\n' +
      rawText;

    const titleReply = await engine.chat.completions.create({
      messages: [{ role: 'user', content: titlePrompt }],
      temperature: 0.1,
      max_tokens: 40
    });

    title = (titleReply.choices[0].message.content || '').trim();
    console.log('Сырой заголовок:', title);
    title = cleanTitle(title);
  } catch (e) {
    console.warn('Не удалось получить заголовок:', e);
  }

  // ЗАПРОС 2: только пункты
  let bullets = [];
  try {
    const bulletsPrompt =
      'Прочитай текст и выпиши факты. Будь ОЧЕНЬ внимателен КТО что делает.\n' +
      'ПРАВИЛА:\n' +
      '1. Каждый факт с новой строки, начинается с "* ".\n' +
      '2. 4-6 фактов.\n' +
      '3. Пересказывай СВОИМИ словами, коротко, по 1 предложению на факт.\n' +
      '4. ВАЖНО: если в тексте сказано "его жена стала телеведущей" — так и пиши, что ЖЕНА стала телеведущей, а не он.\n' +
      '5. Не смешивай факты в один. Один факт — одна мысль.\n' +
      '6. НЕ придумывай. Если чего-то нет в тексте — не пиши.\n' +
      '7. Не повторяй одинаковое.\n' +
      '8. Никаких вступлений и выводов.\n\n' +
      'ПРИМЕР как надо:\n' +
      'Текст: "Иван был полицейским. Его жена работала врачом. У них родился сын."\n' +
      'Ответ:\n' +
      '* Иван работал полицейским\n' +
      '* Жена Ивана была врачом\n' +
      '* У них родился сын\n\n' +
      'ТЕКСТ:\n' +
      rawText;

    const bulletsReply = await engine.chat.completions.create({
      messages: [{ role: 'user', content: bulletsPrompt }],
      temperature: 0.15,
      max_tokens: 600
    });

    const rawBullets = (bulletsReply.choices[0].message.content || '').trim();
    console.log('Сырые пункты:', rawBullets);
    bullets = extractBullets(rawBullets);
  } catch (e) {
    console.warn('Не удалось получить пункты:', e);
  }

  // Если что-то не получилось — локальный fallback
  if (!title) {
    const local = localSummarize(rawText);
    title = local.title;
  }
  if (bullets.length < 2) {
    const local = localSummarize(rawText);
    const localBullets = local.content
      .split('\n')
      .map(l => l.replace(/^[•*\-]\s*/, '').trim())
      .filter(Boolean);
    for (const lb of localBullets) {
      if (bullets.length >= 4) break;
      const key = lb.toLowerCase().replace(/[^а-яёa-z0-9]/gi, '').slice(0, 50);
      const exists = bullets.some(b =>
        b.toLowerCase().replace(/[^а-яёa-z0-9]/gi, '').slice(0, 50) === key
      );
      if (!exists) bullets.push(lb);
    }
  }

  const content = bullets
    .map(b => {
      const clean = b.replace(/[.!?:;,]+$/, '').trim();
      return '• ' + clean.charAt(0).toUpperCase() + clean.slice(1);
    })
    .join('\n');

  return { title, content };
}

  // ============================================================
  //  РАЗБОР ОТВЕТА ИИ
  // ============================================================
function cleanTitle(raw) {
  let t = (raw || '').trim();

  // Берём первую непустую строку
  const firstLine = t.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
  t = firstLine;

  // Убираем служебные префиксы
  t = t.replace(/^(заголовок|тема|ответ|title)\s*[:\-]\s*/i, '');

  // Убираем кавычки, скобки, markdown
  t = t
    .replace(/^[<«»„“”"'`*#\-\d.\s]+/, '')
    .replace(/[<«»„“”"'`*#]+$/, '')
    .replace(/[<>]/g, '')
    .replace(/\*\*/g, '')
    .replace(/[.!?:;]+$/, '')
    .trim();

  // Убираем Title Case, если он нерусский
  const words = t.split(/\s+/);
  const capWords = words.filter(w => /^[А-ЯЁA-Z]/.test(w)).length;
  if (words.length >= 3 && capWords === words.length) {
    t = words.map((w, i) => {
      if (i === 0) return w;
      if (/^[А-ЯЁA-Z]{2,}/.test(w)) return w; // аббревиатуры
      return w.charAt(0).toLowerCase() + w.slice(1);
    }).join(' ');
  }

  // Обрезаем до 55 символов по последнему пробелу
  if (t.length > 55) {
    t = t.slice(0, 55);
    const sp = t.lastIndexOf(' ');
    if (sp > 25) t = t.slice(0, sp);
  }

  return t;
}

function extractBullets(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const bullets = [];

  for (const line of lines) {
    // Пункт со звёздочкой, дефисом, точкой или цифрой
    const m = line.match(/^[*\-•]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (m) {
      const b = m[1]
        .replace(/^["«»„“”]+|["«»„“”]+$/g, '')
        .replace(/[.!?:;,]+$/, '')
        .trim();
      if (b.length > 8) bullets.push(b);
      continue;
    }
    // Строка без маркера, но длинная и не похожа на служебную
    if (line.length > 20 && !/^(заголовок|тема|пункты|ответ|вот)\s*[:\-]?/i.test(line)) {
      const b = line
        .replace(/^[*\-•#\d.\s]+/, '')
        .replace(/[.!?:;,]+$/, '')
        .trim();
      if (b.length > 8) bullets.push(b);
    }
  }

  // Убираем дубли
  const seen = new Set();
  return bullets.filter(b => {
    const key = b.toLowerCase().replace(/[^а-яёa-z0-9]/gi, '').slice(0, 50);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

  // ============================================================
  //  ЛОКАЛЬНАЯ ОБРАБОТКА (запасной вариант)
  // ============================================================
  function localSummarize(rawText) {
    const fillers = /\b(ну|вот|это|этот|эта|как бы|типа|короче|значит|так сказать|в общем|вообщем|эээ+|эм+|ммм+|ааа+|ага|угу|так|ладно|да|нет)\b/gi;

    let clean = rawText
      .replace(fillers, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim();

    let sentences = clean
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);

    if (sentences.length < 3) {
      sentences = clean
        .split(/[,;]\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 15);
    }

    if (sentences.length === 0) return { title: 'Конспект', content: rawText };

    let title = sentences[0];
    if (title.length > 60) title = title.slice(0, 60).trim() + '…';

    const rest = sentences.slice(1);
    const bullets = rest.map((s) => {
      let t = s.trim();
      t = t.charAt(0).toUpperCase() + t.slice(1);
      if (!/[.!?…]$/.test(t)) t += '.';
      return '• ' + t;
    });

    const content = bullets.length ? bullets.join('\n') : '• ' + sentences[0];
    return { title, content };
  }

  // ============================================================
  //  СОХРАНЕНИЕ
  // ============================================================
  function saveNotes() {
    try {
      localStorage.setItem('notes_v1', JSON.stringify(notes));
    } catch (e) {
      alert('Не удалось сохранить (нет места в хранилище)');
    }
  }

  // ============================================================
  //  СПИСОК КОНСПЕКТОВ
  // ============================================================
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderNotes() {
    if (!notes.length) {
      notesList.innerHTML = '<div class="empty">Пока нет конспектов.<br>Запишите первый!</div>';
      return;
    }

    notesList.innerHTML = notes
      .map((n) => {
        const preview = (n.content || '').replace(/\n+/g, ' ').slice(0, 120);
        return (
          '<div class="note-item" data-id="' + n.id + '">' +
            '<div class="note-title">' + escapeHtml(n.title || 'Конспект') + '</div>' +
            '<div class="note-date">' + escapeHtml(n.date || '') + '</div>' +
            '<div class="note-preview">' + escapeHtml(preview) + '</div>' +
          '</div>'
        );
      })
      .join('');

    notesList.querySelectorAll('.note-item').forEach((el) => {
      el.addEventListener('click', () => openNote(Number(el.dataset.id)));
    });
  }

  function openNote(id) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    currentNoteId = id;
    noteTitle.textContent = note.title || 'Конспект';
    noteDate.textContent = note.date || '';
    noteContent.textContent = note.content || '';
    noteContent.scrollTop = 0;
    showScreen('noteDetailScreen');
  }

  // ============================================================
  //  ДЕЙСТВИЯ С КОНСПЕКТОМ
  // ============================================================
  deleteNoteBtn.addEventListener('click', () => {
    if (!currentNoteId) return;
    if (!confirm('Удалить конспект?')) return;
    notes = notes.filter((n) => n.id !== currentNoteId);
    saveNotes();
    currentNoteId = null;
    showScreen('notesScreen');
  });

  copyNoteBtn.addEventListener('click', async () => {
    const note = notes.find((n) => n.id === currentNoteId);
    if (!note) return;
    const text = (note.title ? note.title + '\n\n' : '') + (note.content || '');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      copyNoteBtn.textContent = 'Скопировано';
      setTimeout(() => { copyNoteBtn.textContent = 'Копировать'; }, 1500);
    } catch (e) {
      alert('Не удалось скопировать');
    }
  });

  // ============================================================
  //  СТАРТ
  // ============================================================
  renderTranscript();

  loadVoskModel();

  setTimeout(() => initWebLLM(), 2000);

  window.addEventListener('beforeunload', (e) => {
    if (recognizing) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();