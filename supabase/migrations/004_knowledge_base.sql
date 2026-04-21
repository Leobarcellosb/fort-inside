-- Fort Inside — Base de conhecimento para o Claude

create table knowledge_base (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  type text not null default 'text', -- 'text' | 'file'
  file_name text,
  created_at timestamptz default now()
);

alter table knowledge_base enable row level security;

-- Admin full access; no public read
create policy "knowledge_base_admin" on knowledge_base
  for all using (is_admin());
