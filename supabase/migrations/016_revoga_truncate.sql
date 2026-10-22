-- 016_revoga_truncate.sql
-- Revoga de anon e authenticated os privilégios que a RLS NÃO governa.
--
-- NÃO APLICAR sem autorização nominal.
--
-- ---------------------------------------------------------------
-- O problema
-- ---------------------------------------------------------------
-- O Supabase concede, por padrão, todos os privilégios de tabela a `anon` e
-- `authenticated` em todo o schema public, e confia na RLS como única barreira.
-- Para SELECT, INSERT, UPDATE e DELETE isso funciona: a RLS é avaliada linha a
-- linha e as policies deste projeto cobrem esses quatro.
--
-- Três privilégios escapam dessa lógica:
--
--   TRUNCATE   -- NÃO passa por RLS. É a exceção que importa: uma policy
--                 restritiva não impede nada, porque TRUNCATE não avalia
--                 linhas. Medido: has_table_privilege('anon', <tabela>,
--                 'truncate') = true em todas as tabelas de public.
--   TRIGGER    -- permite criar gatilho numa tabela que o papel não possui.
--                 Gatilho executa código; é escalada de privilégio em potencial.
--   REFERENCES -- permite criar chave estrangeira apontando para a tabela, o
--                 que vaza existência de valores por erro de integridade e
--                 passa a bloquear exclusões legítimas.
--
-- Nenhum dos três é exposto pelo PostgREST hoje, então isto NÃO é falha
-- explorável pela API neste momento -- é endurecimento. Mas a RLS ser "a única
-- barreira" só é verdade para os privilégios que ela de fato governa, e esses
-- três não são.

revoke truncate, trigger, references on all tables in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;

-- ---------------------------------------------------------------
-- E para as tabelas que ainda não existem
-- ---------------------------------------------------------------
-- O revoke acima vale só para as tabelas de agora. Sem mexer nos default
-- privileges, a próxima migration que criar tabela reabre o buraco em silêncio
-- -- e ninguém vai lembrar desta aqui. É exatamente o padrão que já nos mordeu:
-- correção pontual que não impede a reincidência.
--
-- O dono dos defaults é quem cria os objetos. As migrations rodam como
-- `postgres`, então é o default dele que governa toda tabela nova criada por
-- migration -- que é o caminho que importa aqui.
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon;
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from authenticated;

-- LIMITAÇÃO CONHECIDA, declarada em vez de disfarçada: tabela criada por outro
-- papel (`supabase_admin`, ou seja, pelo dashboard da plataforma) continua
-- nascendo com os privilégios padrão do Supabase, TRUNCATE incluído. Cobrir
-- isso exigiria `alter default privileges for role supabase_admin`, que
-- `postgres` não pode executar -- medido: "ERROR: permission denied to change
-- default privileges", porque é preciso ser membro do papel.
--
-- O controle compensatório já existe e é o certo para esta classe: tabela
-- criada fora das migrations é exatamente o que o guard de drift acusa como
-- POLICY/OBJETO NÃO DECLARADO. Foi assim que a policy anônima de NPS, criada à
-- mão no dashboard, apareceu. Então o caminho não coberto aqui é coberto lá.

-- service_role segue com tudo: é por ele que as rotas administrativas e o
-- processamento em lote escrevem, e ele ignora RLS por desenho.
--
-- SELECT, INSERT, UPDATE e DELETE continuam concedidos a anon e authenticated,
-- governados pelas policies. Revogá-los aqui quebraria o produto inteiro, e a
-- 014 já mostrou qual é a forma correta de travar escrita quando necessário:
-- revogar no nível da tabela e reconceder por coluna.
