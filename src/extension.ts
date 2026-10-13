import * as vscode from 'vscode';

//Размеры базовых типов C++ в байтах
const typesize: Map<string, number> = new Map<string, number>([
    ['bool', 1],
    ['char', 1],
    ['short', 2],
    ['int', 4],
    ['long long', 8],
    ['size_t', 8],
    ['float', 4],
    ['double', 8],
    ['long double', 16],
]);

//Накладные расходы контейнеров для алгоритмов в байтах
const ALGORITHMS: Map<string, number> = new Map<string, number>([
    ['BFS',      80],
    ['DIJKSTRA', 24],
    ['MST',      24],
]);

//Информация об одном объявлении
interface Declaration {
    type: string;
    name: string;
    dimensions: string[];
    bytesPerElement: number;
}

//Надпись в статус-баре
let statusBar: vscode.StatusBarItem;

//Активирует расширение
export function activate(context: vscode.ExtensionContext) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBar);

    const cmd = vscode.commands.registerCommand('memorysize.run', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Открой файл C++.');
            return;
        }
        if (editor.document.languageId !== 'cpp' && editor.document.languageId !== 'c') {
            vscode.window.showWarningMessage('Только для файлов C/C++.');
            return;
        }
        const text = editor.document.getText();
        const decls = parseDeclarations(text);
        if (decls.length === 0) {
            vscode.window.showInformationMessage('Объявлений не найдено.');
            return;
        }
        const symbols = new Set<string>();
        for (const d of decls) {
            for (const dim of d.dimensions) {
                for (const m of dim.matchAll(/[a-zA-Z_]\w*/g)) {
                    symbols.add(m[0]);
                }
            }
        }

        const values: Map<string, number> = new Map<string, number>();
        for (const sym of symbols) {
            const input = await vscode.window.showInputBox({
                prompt: `Значение "${sym}"`,
                placeHolder: 'Введите число',
                validateInput: v => /^\d+$/.test(v) ? null : 'Введите число',
            });
            if (input === undefined) {
                return;
            }
            values.set(sym, Number(input));
        }
        const total = computeTotalMemory(decls, values);
        statusBar.text = `Память: ${fmt(total)}`;
        statusBar.show();
    });

    context.subscriptions.push(cmd);
}

//Ищет ВСЕ объявления: массивы, векторы, пары, аннотации алгоритмов
function parseDeclarations(text: string): Declaration[] {
    const result: Declaration[] = [];
    result.push(...parsestaticarrayDeclarations(text));
    result.push(...parseVectors(text));
    result.push(...parsePairs(text));
    result.push(...parseAnnotations(text));
    return result;
}

//Ищет объявления статических массивов в тексте
function parsestaticarrayDeclarations(text: string): Declaration[] {
    const result: Declaration[] = [];
    const regex = /(int|long\s+long|long|short|char|bool|float|double)\s+([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        const type = m[1].replace(/\s+/g, ' '), size = typesize.get(type);
        if (!size) {
            continue;
        }
        const list = m[2].split(',').map(s => s.trim()).filter(s => s.length > 0);
        for (const part of list) {
            const parsed = part.match(/^([a-zA-Z_]\w*)\s*((?:\[[^\]]+\])*)$/);
            if (!parsed) {
                continue;
            }
            const name = parsed[1];
            const dims = [...parsed[2].matchAll(/\[([^\]]+)\]/g)].map(x => x[1].trim());
            if (dims.length === 0) {
                continue;
            }
            result.push({ type, name, dimensions: dims, bytesPerElement: size });
        }
    }
    return result;
}

//Извлекает содержимое угловых скобок: vector<pair<int,int>> -> "pair<int,int>"
function extractTemplateArg(typeStr: string): string | null {
    const lt = typeStr.indexOf('<');
    if (lt === -1) {
        return null;
    }
    let depth = 1;
    let i = lt + 1;
    const start = i;
    while (i < typeStr.length && depth > 0) {
        if (typeStr[i] === '<') {
            depth++;
        }
        else if (typeStr[i] === '>') {
            depth--;
        }
        i++;
    }
    if (depth !== 0) {
        return null;
    }
    return typeStr.substring(start, i - 1).trim();
}

//Возвращает размер типа в байтах (рекурсивно для pair и vector)
function getTypeSize(type: string): number | null {
    type = type.trim();

    const simple = typesize.get(type);
    if (simple !== undefined) {
        return simple;
    }

    if (type.startsWith('vector')) {
        return 24;
    }

    if (type.startsWith('pair')) {
        const inner = extractTemplateArg(type);
        if (!inner) {
            return null;
        }
        const args = splitTopLevel(inner);
        if (args.length !== 2) {
            return null;
        }
        const s1 = getTypeSize(args[0]);
        const s2 = getTypeSize(args[1]);
        if (s1 === null || s2 === null) {
            return null;
        }
        return s1 + s2;
    }

    return null;
}

//Ищет объявления vector<...> в тексте (любой размерности)
function parseVectors(text: string): Declaration[] {
    const result: Declaration[] = [], re = /\bvector\s*</g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        let i = start + m[0].length, angle = 1;
        while (i < text.length && angle > 0) {
            if (text[i] === '<') {
                angle++;
            }
            else if (text[i] === '>') {
                angle--;
            }
            i++;
        }
        if (angle !== 0) {
            break;
        }
        const typeStr = text.substring(start, i);
        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
        const nameMatch = /^([a-zA-Z_]\w*)/.exec(text.substring(i));
        if (!nameMatch) {
            continue;
        }
        const name = nameMatch[1];
        i += name.length;
        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
        if (text[i] !== '(') {
            continue;
        }
        i++;
        let paren = 1;
        const argsStart = i;
        while (i < text.length && paren > 0) {
            if (text[i] === '(') {
                paren++;
            }
            else if (text[i] === ')') {
                paren--;
            }
            i++;
        }
        if (paren !== 0) {
            continue;
        }
        const argsStr = text.substring(argsStart, i - 1);

        const inner = extractTemplateArg(typeStr);
        if (!inner) {
            continue;
        }
        const size = getTypeSize(inner);
        if (size === null) {
            continue;
        }

        const dims = parseVectorArgs(argsStr);
        if (dims.length === 0) {
            continue;
        }
        result.push({
            type: typeStr.replace(/\s+/g, ' '),
            name,
            dimensions: dims,
            bytesPerElement: size,
        });
    }
    return result;
}

//Ищет объявления pair<...> (не внутри vector)
function parsePairs(text: string): Declaration[] {
    const result: Declaration[] = [];
    const re = /\bpair\s*</g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        const start = m.index;

        const before = text.substring(Math.max(0, start - 10), start);
        if (before.includes('vector')) {
            continue;
        }

        let i = start + m[0].length, angle = 1;
        while (i < text.length && angle > 0) {
            if (text[i] === '<') {
                angle++;
            }
            else if (text[i] === '>') {
                angle--;
            }
            i++;
        }
        if (angle !== 0) {
            break;
        }
        const typeStr = text.substring(start, i);

        const size = getTypeSize(typeStr);
        if (size === null) {
            continue;
        }

        const rest = text.substring(i);
        const match = /^\s*([^;]+);/.exec(rest);
        if (!match) {
            continue;
        }
        const list = match[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
        for (const part of list) {
            const parsed = part.match(/^([a-zA-Z_]\w*)\s*((?:\[[^\]]+\])*)$/);
            if (!parsed) {
                continue;
            }
            const name = parsed[1];
            const dims = [...parsed[2].matchAll(/\[([^\]]+)\]/g)].map(x => x[1].trim());
            result.push({
                type: typeStr.replace(/\s+/g, ' '),
                name,
                dimensions: dims.length > 0 ? dims : ['1'],
                bytesPerElement: size,
            });
        }
    }
    return result;
}

//Ищет аннотации ///ALGO в тексте
//Формат: ///ALGO размер количество_полей тип1, тип2, ..., типN
function parseAnnotations(text: string): Declaration[] {
    const result: Declaration[] = [];
    const re = /^\s*\/\/\/(\w+)\s+([^\n]+)/gm;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        const algo = m[1].toUpperCase();
        const paramsStr = m[2].trim();

        const overhead = ALGORITHMS.get(algo);
        if (overhead === undefined) {
            continue;
        }

        const tokens = paramsStr.split(/\s+/).filter(s => s.length > 0);
        if (tokens.length < 3) {
            continue;
        }

        const sizeExpr = tokens[0];
        const fieldCount = parseInt(tokens[1], 10);
        if (isNaN(fieldCount) || fieldCount <= 0) {
            continue;
        }

        const typeStr = tokens.slice(2).join(' ');
        const types = typeStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
        if (types.length !== fieldCount) {
            continue;
        }

        let structSize = 0;
        let ok = true;
        for (const t of types) {
            const s = getTypeSize(t);
            if (s === null) {
                ok = false;
                break;
            }
            structSize += s;
        }
        if (!ok) {
            continue;
        }

        const formula = `${sizeExpr} * ${structSize} + ${overhead}`;

        result.push({
            type: `ALGO:${algo}`,
            name: `${algo.toLowerCase()}_structure`,
            dimensions: [formula],
            bytesPerElement: 1,
        });
    }
    return result;
}

//Разбирает аргументы конструктора вектора и извлекает размерности
function parseVectorArgs(args: string): string[] {
    const parts = splitTopLevel(args);
    if (parts.length === 0) {
        return [];
    }
    const dims: string[] = [parts[0].trim()];
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].trim();
        const nested = /vector\s*<[\s\S]*>\s*\(([\s\S]*)\)/.exec(part);
        if (nested) {
            dims.push(...parseVectorArgs(nested[1]));
        }
    }
    return dims;
}

//Делит строку по запятым верхнего уровня (с учётом <> и ())
function splitTopLevel(s: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '<' || c === '(') {
            depth++;
        }
        else if (c === '>' || c === ')') {
            depth--;
        }
        else if (c === ',' && depth === 0) {
            result.push(s.substring(last, i));
            last = i + 1;
        }
    }
    result.push(s.substring(last));
    return result;
}

//Считает суммарный объём памяти по всем объявлениям
function computeTotalMemory(decls: Declaration[], values: Map<string, number>): number {
    let total = 0;
    for (const d of decls) {
        let elements = 1;
        for (const dim of d.dimensions) {
            let expr = dim;
            for (const [k, v] of values) {
                expr = expr.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v));
            }
            if (!/^[\d\s+\-*/()]+$/.test(expr)) {
                elements = -1;
                break;
            }
            elements *= Number(eval(expr));
        }
        if (elements < 0) {
            continue;
        }
        total += elements * d.bytesPerElement;
    }
    return total;
}

//Форматирует байты в КБ/МБ
function fmt(b: number): string {
    if (b < 1024) {
        return b + ' Б';
    }
    if (b < 1024 * 1024) {
        return (b / 1024).toFixed(2) + ' КБ';
    }
    return (b / 1024 / 1024).toFixed(2) + ' МБ';
}

//Деактивация
export function deactivate() {}