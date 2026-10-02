#!/usr/bin/env node

const fs = require('fs');
const https = require('https');

const CONFIG = {
  DELAY_BETWEEN_REQUESTS: 100,
  REQUEST_TIMEOUT: 0,
  BATCH_SIZE: 5,
};

// Google отвечает 429 ("We're sorry... automated queries") на TLS-рукопожатие,
// которое по умолчанию делает модуль https (без ALPN). С ALPN рукопожатие
// совпадает с тем, что делает встроенный в Node fetch, и запросы проходят.
const translateAgent = new https.Agent({
  keepAlive: true,
  ALPNProtocols: ['http/1.1'],
});

const ERROR_MARKER = '[ОШИБКА ПЕРЕВОДА]';
// Цели, в которые предыдущие запуски записали ошибку вместо перевода
const ERROR_MARKER_REGEX = /^\[ОШИБКА( ПЕРЕВОДА)?\]/;

class XLFTranslator {
  constructor() {
    this.processedCount = 0;
    this.failedCount = 0;
    this.totalCount = 0;
  }

  // Функция для извлечения XML тегов из текста
  extractXMLTags(text) {
    const tags = [];
    const tagRegex = /<x\s+[^>]*?\/?>/g;
    let match;

    while ((match = tagRegex.exec(text)) !== null) {
      tags.push({
        tag: match[0],
        index: match.index,
        length: match[0].length,
      });
    }

    return tags;
  }

  // Функция для замены XML тегов на плейсхолдеры
  replaceXMLTagsWithPlaceholders(text) {
    const tags = this.extractXMLTags(text);
    let result = text;
    const placeholders = [];

    // Заменяем теги на плейсхолдеры в обратном порядке, чтобы не сбить индексы
    for (let i = tags.length - 1; i >= 0; i--) {
      const tag = tags[i];
      const placeholder = `__XML_TAG_${i}__`;
      placeholders[i] = tag.tag;
      result =
        result.substring(0, tag.index) +
        placeholder +
        result.substring(tag.index + tag.length);
    }

    return { text: result, placeholders };
  }

  restoreXMLTags(text, placeholders) {
    let result = text;

    for (let i = 0; i < placeholders.length; i++) {
      const variants = [
        `__XML_TAG_${i}__`,
        `__xml_tag_${i}__`,
        `__Xml_Tag_${i}__`,
        `__XML_tag_${i}__`,
        `__xml_TAG_${i}__`,
      ];

      for (const variant of variants) {
        result = result.replace(
          new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          placeholders[i],
        );
      }
    }

    return result;
  }

  // Функция для перевода текста через Google Translate
  async translateText(text, fromLang = 'ru', toLang = 'tr') {
    return new Promise((resolve, reject) => {
      console.log(
        `Переводим: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
      );

      // Извлекаем XML теги и заменяем их на плейсхолдеры
      const { text: textWithoutTags, placeholders } =
        this.replaceXMLTagsWithPlaceholders(text);

      if (placeholders.length > 0) {
        console.log(`  Найдено ${placeholders.length} XML тегов`);
      }

      // Кодируем текст для URL
      const encodedText = encodeURIComponent(textWithoutTags);

      // URL для Google Translate (более полная версия)
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${fromLang}&tl=${toLang}&dt=t&dt=bd&dt=ex&dt=ld&dt=md&dt=qca&dt=rw&dt=rm&dt=ss&dt=at&q=${encodedText}`;

      const request = https.get(
        url,
        {
          agent: translateAgent,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          },
        },
        (response) => {
          let data = '';

          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            if (response.statusCode !== 200) {
              const body = data
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ');
              reject(
                new Error(
                  `HTTP ${response.statusCode} ${response.statusMessage}: ${body
                    .trim()
                    .substring(0, 200)}`,
                ),
              );
              return;
            }

            try {
              const result = JSON.parse(data);
              if (result && result[0] && result[0][0] && result[0][0][0]) {
                // Восстанавливаем XML теги
                const translatedText = this.restoreXMLTags(
                  result[0][0][0],
                  placeholders,
                );
                console.log(`Результат: "${translatedText}"`);
                resolve(translatedText);
              } else {
                reject(
                  new Error('Неожиданный формат ответа от Google Translate'),
                );
              }
            } catch (error) {
              reject(new Error(`Ошибка парсинга ответа: ${error.message}`));
            }
          });
        },
      );

      request.on('error', (error) => {
        reject(new Error(`Ошибка запроса: ${error.message}`));
      });
    });
  }

  // Функция для безопасного перевода с повторными попытками
  async safeTranslate(text, fromLang = 'ru', toLang = 'tr', maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.translateText(text, fromLang, toLang);
        return result;
      } catch (error) {
        console.error(`Попытка ${attempt} неудачна: ${error.message}`);

        if (attempt === maxRetries) {
          console.error(
            `Не удалось перевести после ${maxRetries} попыток: "${text}"`,
          );
          return `${ERROR_MARKER} ${text}`;
        }

        // Минимальная задержка при повторных попытках
        await this.sleep(1000);
      }
    }
  }

  // Функция для задержки
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  parseXLF(content) {
    const transUnits = [];
    const lines = content.split('\n');
    let currentUnit = null;
    let inSource = false;
    let inTarget = false;
    let sourceLines = [];
    let targetLines = [];
    let targetStartLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes('<trans-unit')) {
        const idMatch = line.match(/id="([^"]+)"/);
        if (idMatch) {
          currentUnit = {
            id: idMatch[1],
            startLine: i,
            source: '',
            target: '',
            targetState: '',
            hasTarget: false,
            sourceStartLine: -1,
            sourceEndLine: -1,
            targetStartLine: -1,
            targetEndLine: -1,
          };
          inSource = false;
          inTarget = false;
          sourceLines = [];
          targetLines = [];
        }
      } else if (line.includes('<source>') && currentUnit) {
        if (line.includes('</source>')) {
          const match = line.match(/<source>(.*?)<\/source>/);
          if (match) {
            currentUnit.source = match[1].trim();
            currentUnit.sourceStartLine = i;
            currentUnit.sourceEndLine = i;
          }
        } else {
          inSource = true;
          sourceLines = [];
          currentUnit.sourceStartLine = i;
          const match = line.match(/<source>(.*)/);
          if (match) {
            sourceLines.push(match[1]);
          }
        }
      } else if (inSource && currentUnit) {
        if (line.includes('</source>')) {
          const match = line.match(/(.*)<\/source>/);
          if (match) {
            sourceLines.push(match[1]);
          }
          currentUnit.source = sourceLines.join('\n').trim();
          currentUnit.sourceEndLine = i;
          inSource = false;
        } else {
          sourceLines.push(line);
        }
      } else if (line.includes('<target') && currentUnit) {
        currentUnit.hasTarget = true;
        const stateMatch = line.match(/state="([^"]+)"/);
        if (stateMatch) {
          currentUnit.targetState = stateMatch[1];
        }

        if (line.includes('</target>')) {
          const match = line.match(/<target[^>]*>(.*?)<\/target>/);
          if (match) {
            currentUnit.target = match[1].trim();
            currentUnit.targetStartLine = i;
            currentUnit.targetEndLine = i;
          }
        } else {
          inTarget = true;
          targetLines = [];
          currentUnit.targetStartLine = i;
          const match = line.match(/<target[^>]*>(.*)/);
          if (match) {
            targetLines.push(match[1]);
          }
        }
      } else if (inTarget && currentUnit) {
        if (line.includes('</target>')) {
          const match = line.match(/(.*)<\/target>/);
          if (match) {
            targetLines.push(match[1]);
          }
          currentUnit.target = targetLines.join('\n').trim();
          currentUnit.targetEndLine = i;
          inTarget = false;
        } else {
          targetLines.push(line);
        }
      } else if (line.includes('</trans-unit>') && currentUnit) {
        transUnits.push(currentUnit);
        currentUnit = null;
        inSource = false;
        inTarget = false;
      }
    }

    return transUnits;
  }

  generateXLF(originalContent, translations, keepState = false) {
    const lines = originalContent.split('\n');
    const result = [];
    let currentUnit = null;
    let inSource = false;
    let inTarget = false;
    let skipTargetLines = false;
    let skipTranslatedTarget = false;
    let skipClosingTag = false;
    let targetIndent = '';
    let targetContentIndent = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes('<trans-unit')) {
        const idMatch = line.match(/id="([^"]+)"/);
        if (idMatch) {
          currentUnit = translations.find((t) => t.id === idMatch[1]);
        }
        result.push(line);
        inSource = false;
        inTarget = false;
        skipTargetLines = false;
        skipTranslatedTarget = false;
        skipClosingTag = false;
        targetIndent = '';
        targetContentIndent = '';
      } else if (line.includes('<source>') && currentUnit) {
        if (line.includes('</source>')) {
          result.push(line);
          inSource = false;
        } else {
          inSource = true;
          result.push(line);
        }
      } else if (inSource && currentUnit) {
        result.push(line);
        if (line.includes('</source>')) {
          inSource = false;
        }
      } else if (line.includes('<target')) {
        const stateMatch = line.match(/state="([^"]+)"/);
        const originalState = stateMatch ? stateMatch[1] : null;

        if (currentUnit) {
          const isTranslated = stateMatch && stateMatch[1] === 'translated';
          skipTranslatedTarget = isTranslated && !currentUnit.translatedText;

          if (skipTranslatedTarget) {
            result.push(line);
            if (line.includes('</target>')) {
              skipTranslatedTarget = false;
              currentUnit = null;
            } else {
              inTarget = true;
            }
          } else if (line.includes('</target>')) {
            if (currentUnit.translatedText) {
              const stateValue =
                keepState && currentUnit.targetState
                  ? currentUnit.targetState
                  : 'translated';
              const match = line.match(/^(\s*)<target[^>]*>(.*?)<\/target>/);
              if (match) {
                const indent = match[1];
                result.push(
                  `${indent}<target state="${stateValue}">${currentUnit.translatedText}</target>`,
                );
              } else {
                const newLine = line.replace(
                  /<target[^>]*>(.*?)<\/target>/,
                  `<target state="${stateValue}">${currentUnit.translatedText}</target>`,
                );
                result.push(newLine);
              }
            } else {
              if (keepState && originalState) {
                const match = line.match(/^(\s*)<target[^>]*>(.*?)<\/target>/);
                if (match) {
                  const indent = match[1];
                  const content = match[2];
                  result.push(
                    `${indent}<target state="${originalState}">${content}</target>`,
                  );
                } else {
                  result.push(line);
                }
              } else {
                result.push(line);
              }
            }
            currentUnit = null;
            inTarget = false;
          } else {
            if (currentUnit.translatedText) {
              const match = line.match(/^(\s*)<target[^>]*>(.*)/);
              targetIndent = match ? match[1] : '';
              const nextLineIndex = i + 1;
              if (
                nextLineIndex < lines.length &&
                !lines[nextLineIndex].includes('</target>')
              ) {
                const nextLineMatch = lines[nextLineIndex].match(/^(\s*)/);
                targetContentIndent = nextLineMatch
                  ? nextLineMatch[1]
                  : targetIndent + '  ';
              } else {
                targetContentIndent = targetIndent + '  ';
              }

              const stateValue =
                keepState && currentUnit.targetState
                  ? currentUnit.targetState
                  : 'translated';
              const translatedLines = currentUnit.translatedText.split('\n');

              if (translatedLines.length === 1) {
                result.push(
                  `${targetIndent}<target state="${stateValue}">${translatedLines[0]}</target>`,
                );
                skipTargetLines = true;
                skipClosingTag = true;
                inTarget = true;
              } else {
                result.push(
                  `${targetIndent}<target state="${stateValue}">${
                    translatedLines[0] || ''
                  }`,
                );
                for (let j = 1; j < translatedLines.length; j++) {
                  result.push(`${targetContentIndent}${translatedLines[j]}`);
                }
                inTarget = true;
                skipTargetLines = true;
              }
            } else {
              if (keepState && originalState) {
                const match = line.match(/^(\s*)<target[^>]*>(.*)/);
                if (match) {
                  targetIndent = match[1];
                  const content = match[2];
                  result.push(
                    `${targetIndent}<target state="${originalState}">${content}`,
                  );
                } else {
                  result.push(line);
                }
              } else {
                result.push(line);
              }
              inTarget = true;
              skipTargetLines = false;
            }
          }
        } else {
          if (keepState && originalState) {
            const match = line.match(/^(\s*)<target[^>]*>(.*)/);
            if (match) {
              targetIndent = match[1];
              const content = match[2];
              if (line.includes('</target>')) {
                const contentMatch = line.match(/<target[^>]*>(.*?)<\/target>/);
                if (contentMatch) {
                  result.push(
                    `${targetIndent}<target state="${originalState}">${contentMatch[1]}</target>`,
                  );
                } else {
                  result.push(line);
                }
              } else {
                result.push(
                  `${targetIndent}<target state="${originalState}">${content}`,
                );
                inTarget = true;
                skipTargetLines = false;
              }
            } else {
              result.push(line);
              if (!line.includes('</target>')) {
                inTarget = true;
              }
            }
          } else {
            result.push(line);
            if (!line.includes('</target>')) {
              inTarget = true;
            }
          }
        }
      } else if (inTarget) {
        if (skipTranslatedTarget) {
          result.push(line);
          if (line.includes('</target>')) {
            inTarget = false;
            skipTranslatedTarget = false;
            currentUnit = null;
          }
        } else if (currentUnit) {
          if (line.includes('</target>')) {
            if (skipClosingTag) {
              skipClosingTag = false;
            } else if (skipTargetLines) {
              result.push(`${targetIndent}</target>`);
            } else {
              result.push(line);
            }
            inTarget = false;
            skipTargetLines = false;
            targetIndent = '';
            targetContentIndent = '';
            currentUnit = null;
          } else if (!skipTargetLines) {
            result.push(line);
          }
        } else {
          result.push(line);
          if (line.includes('</target>')) {
            inTarget = false;
          }
        }
      } else {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  async translateBatch(units, fromLang, toLang) {
    const results = await Promise.all(
      units.map(async (unit) => {
        try {
          const translatedText = await this.safeTranslate(
            unit.source,
            fromLang,
            toLang,
          );
          unit.translatedText = translatedText;
          this.processedCount++;
          if (translatedText.startsWith(ERROR_MARKER)) {
            this.failedCount++;
          }
          return unit;
        } catch (error) {
          console.error(
            `Ошибка перевода элемента ${unit.id}: ${error.message}`,
          );
          unit.translatedText = `[ОШИБКА] ${unit.source}`;
          this.processedCount++;
          this.failedCount++;
          return unit;
        }
      }),
    );
    return results;
  }

  async translateXLF(
    inputFile,
    outputFile,
    fromLang = 'ru',
    toLang = 'tr',
    keepState = false,
    batchSize = CONFIG.BATCH_SIZE,
  ) {
    try {
      console.log(`Читаем файл: ${inputFile}`);
      const content = fs.readFileSync(inputFile, 'utf8');

      console.log('Парсим XLF файл...');
      const transUnits = this.parseXLF(content);

      console.log(`Найдено ${transUnits.length} элементов для перевода`);

      const toTranslate = transUnits.filter((unit) => {
        if (!unit.source) {
          return false;
        }
        if (!unit.hasTarget) {
          return true;
        }
        if (ERROR_MARKER_REGEX.test(unit.target)) {
          return true;
        }
        if (unit.targetState === 'translated' || unit.targetState === 'final') {
          return false;
        }
        if (unit.targetState === 'new' || unit.target === unit.source) {
          return true;
        }
        return true;
      });

      console.log(`Элементов для перевода: ${toTranslate.length}`);

      if (toTranslate.length === 0) {
        console.log('Нет элементов для перевода');
        return;
      }

      const maxElements = process.env.MAX_ELEMENTS
        ? parseInt(process.env.MAX_ELEMENTS)
        : toTranslate.length;
      const elementsToProcess = toTranslate.slice(0, maxElements);

      console.log(
        `Будем переводить ${elementsToProcess.length} элементов (из ${toTranslate.length})`,
      );
      console.log(`Размер батча: ${batchSize}`);

      this.totalCount = elementsToProcess.length;
      this.processedCount = 0;
      this.failedCount = 0;

      for (let i = 0; i < elementsToProcess.length; i += batchSize) {
        const batch = elementsToProcess.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(elementsToProcess.length / batchSize);

        console.log(
          `\n[Батч ${batchNumber}/${totalBatches}] Обрабатываем ${batch.length} элементов`,
        );

        await this.translateBatch(batch, fromLang, toLang);

        console.log(
          `Прогресс: ${this.processedCount}/${this.totalCount} (${Math.round(
            (this.processedCount / this.totalCount) * 100,
          )}%)`,
        );

        if (i + batchSize < elementsToProcess.length) {
          await this.sleep(CONFIG.DELAY_BETWEEN_REQUESTS);
        }
      }

      console.log('Генерируем новый XLF файл...');
      const newContent = this.generateXLF(content, transUnits, keepState);

      console.log(`Сохраняем результат в: ${outputFile}`);
      fs.writeFileSync(outputFile, newContent, 'utf8');

      console.log('Перевод завершен!');
      console.log(
        `Переведено элементов: ${this.processedCount - this.failedCount}/${
          this.totalCount
        }`,
      );
      if (this.failedCount > 0) {
        console.error(
          `Ошибок перевода: ${this.failedCount}. Такие элементы помечены ${ERROR_MARKER} и будут переведены повторно при следующем запуске`,
        );
      }
    } catch (error) {
      console.error('Ошибка:', error.message);
      process.exit(1);
    }
  }
}

function extractLanguageFromFilename(filename) {
  const match = filename.match(/\.([a-z]{2})\.xlf$/i);
  return match ? match[1].toLowerCase() : null;
}

function findXLFFiles(directory = '.') {
  const files = fs.readdirSync(directory);
  return files.filter((file) => file.endsWith('.xlf'));
}

async function main() {
  const args = process.argv.slice(2);

  let fromLang = 'ru';
  let keepState = false;
  let batchSize = CONFIG.BATCH_SIZE;
  let excludeLangs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep-state') {
      keepState = true;
    } else if (args[i].startsWith('--batch-size=')) {
      batchSize = parseInt(args[i].split('=')[1]) || CONFIG.BATCH_SIZE;
    } else if (args[i].startsWith('--exclude=')) {
      const langs = args[i]
        .split('=')[1]
        .split(',')
        .map((l) => l.trim().toLowerCase());
      excludeLangs = langs;
    } else if (args[i].startsWith('--from=')) {
      fromLang = args[i].split('=')[1].toLowerCase();
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Использование: node translate-xlf-fast.js [опции]');
      console.log('');
      console.log('Опции:');
      console.log('  --from=XX          Исходный язык (по умолчанию: ru)');
      console.log(
        '  --exclude=XX,YY    Исключить языки из обработки (через запятую)',
      );
      console.log('  --keep-state       Сохранять исходное значение state');
      console.log('  --batch-size=N     Размер батча (по умолчанию: 5)');
      console.log('  --help, -h         Показать эту справку');
      console.log('');
      console.log('Примеры:');
      console.log('  node translate-xlf-fast.js');
      console.log('  node translate-xlf-fast.js --exclude=en,hy');
      console.log(
        '  node translate-xlf-fast.js --from=ru --exclude=en --batch-size=10',
      );
      process.exit(0);
    }
  }

  console.log('=== Быстрый Переводчик XLF файлов ===');
  console.log(`Исходный язык: ${fromLang}`);
  console.log(`Задержка между запросами: ${CONFIG.DELAY_BETWEEN_REQUESTS}ms`);
  console.log(`Размер батча: ${batchSize}`);
  console.log(`Сохранять исходный state: ${keepState ? 'да' : 'нет'}`);
  if (excludeLangs.length > 0) {
    console.log(`Исключенные языки: ${excludeLangs.join(', ')}`);
  }
  console.log('');

  const currentDir = process.cwd();
  const xlfFiles = findXLFFiles(currentDir);

  if (xlfFiles.length === 0) {
    console.log('Не найдено XLF файлов в текущей директории');
    process.exit(1);
  }

  console.log(`Найдено XLF файлов: ${xlfFiles.length}`);

  const filesToProcess = [];
  for (const file of xlfFiles) {
    const lang = extractLanguageFromFilename(file);
    if (!lang) {
      console.log(`Пропускаем файл без языка: ${file}`);
      continue;
    }
    if (excludeLangs.includes(lang)) {
      console.log(`Пропускаем исключенный язык: ${file} (${lang})`);
      continue;
    }
    filesToProcess.push({ file, lang });
  }

  if (filesToProcess.length === 0) {
    console.log('Нет файлов для обработки');
    process.exit(0);
  }

  console.log(`Файлов для обработки: ${filesToProcess.length}`);
  console.log('');

  const translator = new XLFTranslator();

  for (let i = 0; i < filesToProcess.length; i++) {
    const { file, lang } = filesToProcess[i];
    console.log(
      `\n[${i + 1}/${filesToProcess.length}] Обрабатываем: ${file} (${fromLang} -> ${lang})`,
    );
    console.log('='.repeat(60));

    await translator.translateXLF(
      file,
      file,
      fromLang,
      lang,
      keepState,
      batchSize,
    );

    if (i < filesToProcess.length - 1) {
      console.log('\nОжидание перед следующим файлом...\n');
      await translator.sleep(1000);
    }
  }

  console.log('\n=== Все файлы обработаны ===');
}

// Запуск скрипта
if (require.main === module) {
  main().catch(console.error);
}

module.exports = XLFTranslator;
