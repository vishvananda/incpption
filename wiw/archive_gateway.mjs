const limit = 96 * 1024 * 1024;

export async function relayArchive(request, fetchArchive = fetch) {
  if (request.method !== 'GET') return new Response(null, {status:405});
  const {searchParams} = new URL(request.url);
  const repo = searchParams.get('repo') || '', sha = searchParams.get('sha') || '';
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      ['.', '..'].includes(repo.split('/')[1]) || !/^[a-f0-9]{40}$/.test(sha))
    return new Response('Expected an owner/repo and a full Git commit', {status:400});
  if (!['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site')))
    return new Response('Use the Will it Wasm page to request an archive', {status:403});
  const url = 'https://codeload.github.com/' + repo + '/tar.gz/' + sha;
  let data;
  try {
    data = await fetchArchive(url, {redirect:'manual', signal:request.signal});
  } catch (error) {
    console.error('GitHub archive fetch failed', error.message);
    return new Response('GitHub archive unavailable', {status:502});
  }
  if (!data.ok) return new Response('GitHub archive unavailable', {status:data.status === 404 ? 404 : 502});
  if (Number(data.headers.get('content-length')) > limit) {
    await data.body.cancel();
    return new Response('The repository archive exceeds 96 MiB', {status:413});
  }
  let received = 0;
  const reader = data.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      const {value, done} = await reader.read();
      if (done) return controller.close();
      received += value.length;
      if (received > limit) {
        await reader.cancel();
        return controller.error(Error('Archive exceeds 96 MiB'));
      }
      controller.enqueue(value);
    },
    cancel(reason) {return reader.cancel(reason);},
  });
  return new Response(stream, {headers:{
    'Content-Type':'application/octet-stream',
    'Cache-Control':'public, max-age=86400, immutable',
    'Cross-Origin-Resource-Policy':'same-origin',
  }});
}
