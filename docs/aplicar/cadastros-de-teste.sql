-- CANDIDATOS A CADASTRO DE TESTE NO MARCO ZERO (so leitura).
--
-- Rode no editor SQL do Supabase. A lista traz quem PARECE teste pelo nome ou
-- pelo e-mail. Nao apaga nada. Quem decide e voce, um por um: responda no chat
-- "remove <id>" ou "mantem <id>" para cada linha. Nome parecido nao prova que e
-- teste (pode existir um participante real chamado Carlos).
--
-- Depois da sua resposta, a remocao e feita numa transacao, com registro em
-- event_logs (identificadores, quantas respostas, motivo, quem autorizou e
-- quando), sem copiar resposta pessoal.

select p.id, p.full_name, p.email, p.completed_at is not null as concluiu, p.joined_at
from public.participants p
join public.events e on e.id = p.event_id
where e.event_code = 'MARCOZERO'
  and (p.email ilike '%innerai%' or p.email ilike '%claude%' or p.email ilike '%anthropic%'
       or p.email ilike '%teste%' or p.email ilike '%test%' or p.email ilike '%exemplo%'
       or p.full_name ilike '%teste%' or p.full_name ilike '%claude%' or p.full_name ilike '%carlos%'
       or p.full_name ilike '%leonardo%' or p.full_name ilike '%barcellos%')
order by p.joined_at;
