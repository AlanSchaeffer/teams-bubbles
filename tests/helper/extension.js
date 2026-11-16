// Só para testes: liga o "unsafe mode" do Shell para que o script de teste
// possa usar org.gnome.Shell.Eval e Screenshot pela D-Bus. Nunca instale
// isto na sessão real.
export default class TestHelper {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
