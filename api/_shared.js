import crypto from "node:crypto";
import net from "node:net";
import vm from "node:vm";
function getSecret() {
    if (process.env.SONDRA_SECRET)
        return process.env.SONDRA_SECRET;
    if (process.env.NODE_ENV === "production" && !process.env.VERCEL_ENV) {
        throw new Error("SONDRA_SECRET muss in production gesetzt sein.");
    }
    return "sondra-unconfigured";
}
const TTL_SECONDS = 60 * 60 * 4;
const b64url = (value) => Buffer.from(value).toString("base64url");
function sign(target, extra = {}) {
    const payload = b64url(JSON.stringify({ u: target, exp: Math.floor(Date.now() / 1e3) + TTL_SECONDS, ...extra }));
    const mac = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
    return `${payload}.${mac}`;
}
function verify(token) {
    if (typeof token !== "string" || !token.includes("."))
        return null;
    const [payload, mac] = token.split(".");
    let secret;
    try {
        secret = getSecret();
    }
    catch {
        return null;
    }
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
        return null;
    try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (typeof data.exp !== "number" || data.exp * 1e3 < Date.now())
            return null;
        return data;
    }
    catch {
        return null;
    }
}
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const parts = ip.split(".").map(Number);
        const [b0, b1] = parts;
        if (b0 === 0)
            return true;
        if (b0 === 10)
            return true;
        if (b0 === 100 && b1 >= 64 && b1 <= 127)
            return true;
        if (b0 === 127)
            return true;
        if (b0 === 169 && b1 === 254)
            return true;
        if (b0 === 172 && b1 >= 16 && b1 <= 31)
            return true;
        if (b0 === 192 && b1 === 0 && parts[2] === 0)
            return true;
        if (b0 === 192 && b1 === 0 && parts[2] === 2)
            return true;
        if (b0 === 192 && b1 === 88 && parts[2] === 99)
            return true;
        if (b0 === 192 && b1 === 168)
            return true;
        if (b0 === 198 && (b1 === 18 || b1 === 19))
            return true;
        if (b0 === 198 && b1 === 51 && parts[2] === 100)
            return true;
        if (b0 === 203 && b1 === 0 && parts[2] === 113)
            return true;
        if (b0 >= 224)
            return true;
        return false;
    }
    if (net.isIPv6(ip)) {
        const clean = ip.toLowerCase();
        if (clean === "::1" || clean === "::")
            return true;
        if (clean.startsWith("::ffff:")) {
            const rest = clean.slice(7);
            if (net.isIPv4(rest))
                return isPrivateIp(rest);
            const hexParts = rest.split(":");
            if (hexParts.length === 2) {
                const p1 = parseInt(hexParts[0], 16);
                const p2 = parseInt(hexParts[1], 16);
                const ipv4 = `${p1 >> 8 & 255}.${p1 & 255}.${p2 >> 8 & 255}.${p2 & 255}`;
                if (net.isIPv4(ipv4))
                    return isPrivateIp(ipv4);
            }
            return true;
        }
        if (/^fe[89ab]/i.test(clean))
            return true;
        if (/^f[cd]/i.test(clean))
            return true;
        if (/^fec/i.test(clean))
            return true;
        if (clean.startsWith("ff"))
            return true;
        if (clean.startsWith("100:") || clean.startsWith("2001:db8:"))
            return true;
        return false;
    }
    return false;
}
function isPrivateHost(hostname) {
    let host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
    if (!host)
        return true;
    if (net.isIP(host))
        return isPrivateIp(host);
    if (host === "localhost" || host.endsWith(".localhost"))
        return true;
    if (/\.(?:local|internal|localdomain|domain|lan|home|corp|test|invalid|example|onion)$/i.test(host))
        return true;
    if (host === "metadata" || host === "instance-data" || host.startsWith("metadata."))
        return true;
    if (!host.includes("."))
        return true;
    return false;
}
function allowedTarget(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    if (url.protocol !== "https:")
        return null;
    if (url.username || url.password)
        return null;
    if (url.port && url.port !== "443" && url.port !== "8443")
        return null;
    if (isPrivateHost(url.hostname))
        return null;
    return url;
}
let innertube = null;
async function youtube() {
    if (innertube)
        return innertube;
    const { Innertube, Platform } = await import("youtubei.js");
    Platform.load({
        ...Platform.shim,
        eval: (data) => new vm.Script(`(function(){${data.output}})()`).runInNewContext(Object.create(null), {
            timeout: 1e4
        })
    });
    try {
        innertube = await Innertube.create({ retrieve_player: true, client_type: "MWEB" });
    }
    catch {
        try {
            innertube = await Innertube.create({ retrieve_player: true, client_type: "ANDROID" });
        }
        catch {
            innertube = await Innertube.create({ retrieve_player: true });
        }
    }
    return innertube;
}
const YOUTUBE_HOST = /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
function youtubeId(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    if (!YOUTUBE_HOST.test(url.hostname))
        return null;
    if (url.hostname.endsWith("youtu.be"))
        return url.pathname.slice(1).split("/")[0] || null;
    if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/")[2] || null;
    }
    return url.searchParams.get("v");
}
const sizeLabel = (format) => {
    const quality = format.quality_label || (format.height ? `${format.height}p` : null);
    if (format.has_video && format.has_audio) {
        return `${quality ?? "Video"} mit Ton`;
    }
    if (format.has_video) {
        const fps = format.fps && format.fps > 30 ? ` \xB7 ${format.fps} fps` : "";
        return `${quality ?? "Video"}${fps}`;
    }
    const bitrate = format.bitrate ? ` \xB7 ${Math.round(format.bitrate / 1e3)} kbit/s` : "";
    return `Nur Ton${bitrate}`;
};
const deciphered = new Map();
const DECIPHERED_TTL_MS = 60 * 60 * 1e3;
async function decipheredUrl(yt, format) {
    try {
        return await format.decipher(yt.session.player) || null;
    }
    catch {
        return null;
    }
}
async function youtubeStreamUrl(id, itag, { fresh = false } = {}) {
    const key = `${id}:${itag}`;
    const cached = deciphered.get(key);
    if (!fresh && cached && Date.now() - cached.at < DECIPHERED_TTL_MS)
        return cached.url;
    const yt = await youtube();
    const info = await yt.getBasicInfo(id);
    const data = info.streaming_data;
    const format = [...data?.formats ?? [], ...data?.adaptive_formats ?? []].find((candidate) => String(candidate.itag) === String(itag));
    const url = format ? await decipheredUrl(yt, format) : null;
    if (url)
        deciphered.set(key, { url, at: Date.now() });
    else
        deciphered.delete(key);
    return url;
}
async function resolveYoutube(id) {
    const yt = await youtube();
    const info = await yt.getBasicInfo(id);
    const status = info.playability_status?.status;
    if (status && status !== "OK") {
        const reason = info.playability_status?.reason || "";
        throw Object.assign(new Error(reason || "Das Video ist nicht abspielbar."), {
            code: status === "LOGIN_REQUIRED" ? "youtube.signin" : "youtube.unplayable"
        });
    }
    const data = info.streaming_data;
    const all = [...data?.formats ?? [], ...data?.adaptive_formats ?? []];
    const streams = [];
    for (const format of all) {
        const url = await decipheredUrl(yt, format);
        if (!url)
            continue;
        deciphered.set(`${id}:${format.itag}`, { url, at: Date.now() });
        streams.push({
            id: String(format.itag),
            label: sizeLabel(format),
            hasVideo: Boolean(format.has_video),
            hasAudio: Boolean(format.has_audio),
            width: format.width ?? null,
            height: format.height ?? null,
            ext: format.mime_type?.includes("webm") ? "webm" : format.has_video ? "mp4" : "m4a",
            mime: format.mime_type?.split(";")[0] ?? "application/octet-stream",
            bytes: format.content_length ? Number(format.content_length) : null,
            token: sign(url, { yt: id, itag: String(format.itag) })
        });
    }
    streams.sort((a, b) => {
        if (a.hasVideo && b.hasVideo) {
            if ((b.height ?? 0) !== (a.height ?? 0))
                return (b.height ?? 0) - (a.height ?? 0);
            const aComplete = Number(a.hasAudio);
            const bComplete = Number(b.hasAudio);
            if (bComplete !== aComplete)
                return bComplete - aComplete;
            const aMp4 = a.ext === "mp4" ? 1 : 0;
            const bMp4 = b.ext === "mp4" ? 1 : 0;
            return bMp4 - aMp4;
        }
        if (a.hasVideo !== b.hasVideo)
            return a.hasVideo ? -1 : 1;
        return (b.bytes ?? 0) - (a.bytes ?? 0);
    });
    return {
        kind: "youtube",
        title: info.basic_info?.title ?? "Video",
        author: info.basic_info?.author ?? null,
        durationSeconds: info.basic_info?.duration ?? null,
        thumbnail: info.basic_info?.thumbnail?.[0]?.url ?? null,
        streams
    };
}
const PROVIDER = (process.env.SONDRA_PROVIDER_URL || "").trim().replace(/\/$/, "");
const PROVIDER_KEY = (process.env.SONDRA_PROVIDER_KEY || "").trim();
function hasProvider() {
    return PROVIDER.length > 0;
}
const QUALITY_LABEL = {
    audio: "Nur Ton",
    mute: "Video ohne Ton",
    auto: "Video mit Ton"
};
function providerStream(url, filename, mode) {
    const ext = (filename?.split(".").pop() || (mode === "audio" ? "mp3" : "mp4")).toLowerCase();
    const video = mode !== "audio";
    return {
        id: `provider-${mode}`,
        label: QUALITY_LABEL[mode] ?? "Datei",
        hasVideo: video,
        hasAudio: mode !== "mute",
        width: null,
        height: null,
        ext,
        mime: video ? `video/${ext === "webm" ? "webm" : "mp4"}` : `audio/${ext === "mp3" ? "mpeg" : ext}`,
        bytes: null,
        token: sign(url)
    };
}
async function resolveViaProvider(target, signal) {
    if (!PROVIDER)
        return null;
    const headers = {
        "content-type": "application/json",
        accept: "application/json"
    };
    if (PROVIDER_KEY)
        headers.authorization = `Api-Key ${PROVIDER_KEY}`;
    const streams = [];
    let filename = null;
    let failure = null;
    for (const mode of ["auto", "audio"]) {
        let answer;
        try {
            const response = await fetch(PROVIDER, {
                method: "POST",
                headers,
                signal,
                body: JSON.stringify({
                    url: target,
                    videoQuality: "1080",
                    audioFormat: "mp3",
                    downloadMode: mode,
                    filenameStyle: "basic",
                    disableMetadata: true
                })
            });
            answer = await response.json();
        }
        catch (cause) {
            failure = String(cause?.message ?? cause);
            continue;
        }
        if (answer?.status === "tunnel" || answer?.status === "redirect") {
            filename = filename ?? answer.filename ?? null;
            streams.push(providerStream(answer.url, answer.filename, mode));
        }
        else if (answer?.status === "picker" && Array.isArray(answer.picker)) {
            for (const [index, item] of answer.picker.entries()) {
                if (!item?.url)
                    continue;
                const stream = providerStream(item.url, item.url.split("/").pop(), item.type === "photo" ? "mute" : mode);
                streams.push({ ...stream, id: `provider-${mode}-${index}`, label: `${stream.label} ${index + 1}` });
            }
        }
        else if (answer?.status === "error") {
            failure = answer?.error?.code ?? "error.api";
        }
    }
    if (streams.length === 0) {
        return failure ? { error: failure } : null;
    }
    return {
        kind: "provider",
        title: (filename ?? "Download").replace(/\.[^.]+$/, ""),
        author: new URL(target).hostname,
        durationSeconds: null,
        thumbnail: null,
        streams
    };
}
export { allowedTarget, getSecret, hasProvider, isPrivateHost, isPrivateIp, resolveViaProvider, resolveYoutube, sign, verify, youtubeId, youtubeStreamUrl };
