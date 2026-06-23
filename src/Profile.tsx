import { useEffect, useState } from 'react';

const SAMPLE = [
  'Shipping a new release today. Spent way too long on the changelog 😅',
  'Hot take: most performance problems are actually measurement problems.',
  'TIL you can profile this with the User Timing API instead of guessing.',
  'Reminder that LCP and TBT measure completely different things.',
  'The bundle is almost always the bigger lever than init timing.',
  'Lighthouse numbers swing ±20% run to run. Always report a median.',
];

const POSTS = Array.from({ length: 100 }, (_, i) => ({
  id: i,
  text: SAMPLE[i % SAMPLE.length]!,
  media: i % 3 === 0 ? `/img/media-${i % 8}.png` : null,
  replies: (i * 7) % 90,
  reposts: (i * 13) % 200,
  likes: (i * 29) % 1500,
}));

// The request burst a real profile page fires on load: bootstrap + side panels +
// paginated feed, over fetch and XHR — the surface Sentry instruments.
function loadProfileData(): Promise<unknown> {
  performance.mark('api:start');
  const xhrGet = (url: string) =>
    new Promise(res => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.onload = () => res(x.responseText);
      x.onerror = () => res(null);
      x.send();
    });
  const urls = [
    'profile.json',
    'followers.json',
    'suggestions.json',
    ...Array.from({ length: 12 }, (_, i) => `feed-${i}.json`),
  ].map(u => `/api/${u}`);
  const fetches = urls.map(u => fetch(u).then(r => r.json()).catch(() => null));
  const xhrs = [xhrGet('/api/profile.json'), xhrGet('/api/feed-0.json')];
  return Promise.all([...fetches, ...xhrs]).then(r => {
    performance.mark('api:end');
    performance.measure('api.batch', 'api:start', 'api:end');
    return r;
  });
}

function PostRow({ post }: { post: (typeof POSTS)[number] }) {
  const [liked, setLiked] = useState(false);
  return (
    <article className="post">
      <img className="pa" src="/img/avatar.png" alt="" width={40} height={40} loading="lazy" />
      <div className="body">
        <div className="meta">
          <b>Abdullah</b> @logaretm · {post.id + 1}h
        </div>
        <div className="text">{post.text}</div>
        {post.media && <img className="media" src={post.media} alt="" width={520} height={260} loading="lazy" />}
        <div className="actions">
          <span>💬 {post.replies}</span>
          <span>🔁 {post.reposts}</span>
          <span onClick={() => setLiked(l => !l)}>{liked ? '❤️' : '🤍'} {post.likes + (liked ? 1 : 0)}</span>
          <span>📤</span>
        </div>
      </div>
    </article>
  );
}

export default function Profile() {
  const [tab, setTab] = useState('Posts');
  useEffect(() => {
    document.title = 'Abdullah (@logaretm) / Profile';
    void loadProfileData();
  }, []);
  return (
    <main>
      <img className="banner" src="/img/banner.png" alt="" width={600} height={200} />
      <img className="avatar" src="/img/avatar.png" alt="" width={134} height={134} />
      <div className="ident">
        <button className="follow">Follow</button>
        <h1>Abdullah</h1>
        <div className="handle">@logaretm</div>
        <div className="bio">
          Building things for the web. Maintainer of a few open-source projects. Opinions are my own and frequently wrong.
        </div>
        <div className="stats">
          <span><b>1,204</b> Following</span>
          <span><b>38.2K</b> Followers</span>
        </div>
        <div className="tabs">
          {['Posts', 'Replies', 'Media', 'Likes'].map(t => (
            <div key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </div>
          ))}
        </div>
      </div>
      {POSTS.map(p => (
        <PostRow key={p.id} post={p} />
      ))}
    </main>
  );
}
