# Simple Voice Room

Primeiro protótipo de sala de voz usando Vite + Supabase + WebRTC.

## Arquitetura
- Frontend: HTML/CSS/JS (Vite), hospedável na Vercel.
- Banco/auth: Supabase Postgres + Supabase Auth.
- Tempo real: Supabase Realtime Broadcast/Presence para sinalização e presença.
- Voz: WebRTC peer-to-peer com STUN público.
- Sem servidor de mídia próprio nesta versão. Isso facilita migrar depois para desktop ou para um backend/SFU dedicado.

## Configuração
1. Crie um projeto no Supabase.
2. Abra SQL Editor e execute `supabase/schema.sql`.
3. No Supabase, confira Auth > Email: esta versão usa um e-mail interno aleatório (`UUID@local.invalid`) e senha; não depende de e-mail real. Para produção, adapte o fluxo de autenticação.
4. Insira uma key em `access_keys` usando o SQL indicado no arquivo.
5. Copie `.env.example` para `.env.local` e preencha as variáveis.
6. Rode `npm install` e `npm run dev`.
7. Para Vercel, importe o repositório e defina as mesmas variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.

## Key de acesso
Keys devem ser longas e aleatórias. O banco guarda apenas o SHA-256 da key. Gere um hash antes de inserir:

```js
await crypto.subtle.digest('SHA-256', new TextEncoder().encode('SUA_KEY'))
```

É mais fácil usar o script `supabase/make-key.html` localmente ou gerar o SHA-256 por outra ferramenta confiável.

## Admin
O cargo não é criado automaticamente. Um administrador pode definir `profiles.is_admin = true` diretamente no Supabase para um usuário. O cliente lê essa coluna e exibe o cargo. As políticas SQL impedem que o usuário comum altere o próprio `is_admin`.

## Limitações intencionais do protótipo
- WebRTC mesh: cada participante se conecta diretamente aos demais. Para salas grandes, migre para um SFU (ex.: LiveKit/mediasoup/Janus).
- STUN público é usado; em algumas redes será necessário TURN para conectividade confiável.
- "Mutar áudio" é local: silencia a reprodução recebida naquele cliente.
- PTT usa a barra de espaço.
- Uma conta pertence a uma única sala via `profiles.room_id`.
- Não há chat, compartilhamento de tela, recuperação de senha ou painel administrativo ainda.
