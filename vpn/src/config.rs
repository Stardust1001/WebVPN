#[derive(Debug)]
pub struct Config {
	pub port: u32,
	pub num_processes: u32,
	pub cache: bool,
	pub cache_dir: String,
	pub intercept_log: bool,
	pub disable_jump: bool,
	pub confirm_jump: bool,
	pub hide_chinease: bool
}
