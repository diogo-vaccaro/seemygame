/** Rust/GStreamer accepts URI strings, while browser WebRTC uses RTCIceServer objects. */
export function toNativeIceServers(servers) {
    if (!Array.isArray(servers)) return null;
    return servers.flatMap(server => {
        if (typeof server === 'string') return [server];
        if (!server || typeof server !== 'object') return [];
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls || server.url];
        return urls.filter(url => typeof url === 'string' && url.trim()).map(url => {
            const match = url.match(/^(turns?):(?:\/\/)?(.*)$/i);
            if (!match || typeof server.username !== 'string' || typeof server.credential !== 'string') return url;
            return `${match[1].toLowerCase()}://${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@${match[2]}`;
        });
    });
}
