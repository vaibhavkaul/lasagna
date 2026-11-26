// Lasagna's directory under $HOME: the install, state, logs, worktrees and the
// home config. Lasagna is a fork that runs beside an installed Pappardelle, so
// it keeps its own directory and neither tool reads or writes the other's
// (~/.pappardelle). The home config inside it keeps Pappardelle's file name,
// .pappardelle.yml: the format is Pappardelle's, read as it is.
//
// The hooks have the same name in plugins/lasagna/hooks/state_db.py, and
// install.sh in LASAGNA_DIR.
export const STATE_DIR_NAME = '.lasagna';
