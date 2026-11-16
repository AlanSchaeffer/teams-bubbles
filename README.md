# Teams Bubbles

Extensão do GNOME Shell que mostra quem te chamou no Teams (web/PWA no Chrome)
como bolhas redondas flutuando no lado direito do monitor escolhido, acima de
todas as janelas (inclusive tela cheia), sem os pop-ups padrão.

## Requisitos

- **Ubuntu 26.04** (GNOME Shell 50). Outras versões do GNOME não carregam a extensão.
- Teams aberto no **Google Chrome** (PWA instalado ou aba).
- No Teams: Configurações → Notificações → mensagens de chat e menções em
  **"Show in activity and banner"** (só "activity" não gera notificação).
- Chrome com permissão de notificação para o site do Teams.
- Em Configurações do Ubuntu → Notificações, o Chrome/Teams **não** pode estar
  desligado (os pop-ups quem esconde é a extensão).

## Instalar

```
cd teams-bubbles
./install.sh
```

Depois **saia e entre na sessão** do Ubuntu (no Wayland o GNOME só carrega
extensões novas no login). Para remover: `./uninstall.sh` e sair/entrar.

## Uso

- Clique na bolha: abre a conversa e remove a bolha
- Botão direito: descarta sem abrir
- Mouse em cima: nome + última mensagem
- Ícone na barra superior: lista pendente, "Limpar lista", monitor e opções:
  - Limpar ao focar o Teams
  - Grupos sem menção (padrão: desligado — só diretas e @menções)
  - Lembretes de reunião (padrão: ligado)
  - Todas as notificações do Chrome (outros sites, uma bolha por site)
  - Esconder pop-ups interceptados
  - Log de diagnóstico (padrão: desligado)

## Limitações

- O tipo da mensagem é deduzido do texto da notificação, testado com o Teams
  mandando notificações em inglês ("@mentioned you"). Em outro idioma pode
  classificar errado.
- Mensagem direta que começa com "Palavra: ..." pode ser confundida com
  mensagem de grupo.

## Diagnóstico

Por padrão a extensão não grava nada em log. Se algo for classificado errado,
ligue **"Log de diagnóstico"** no menu, reproduza o problema e veja:

```
journalctl --user -o cat | grep teams-bubbles
```

O log contém o título de cada notificação (nomes de pessoas/grupos). Desligue
depois de diagnosticar.

## Licença

MIT — veja [LICENSE](LICENSE).
