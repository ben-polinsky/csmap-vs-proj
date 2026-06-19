#include "compare_core.hpp"

#include <cstdlib>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>

namespace {

std::map<std::string, std::string> parseArgs(int argc, char** argv) {
  std::map<std::string, std::string> args;
  for (int i = 1; i < argc; i += 2) {
    if (i + 1 >= argc) {
      throw std::runtime_error(std::string("missing value for ") + argv[i]);
    }
    args[argv[i]] = argv[i + 1];
  }
  return args;
}

std::string required(const std::map<std::string, std::string>& args, const std::string& name) {
  auto it = args.find(name);
  if (it == args.end() || it->second.empty()) {
    throw std::runtime_error("missing required option " + name);
  }
  return it->second;
}

csmap_proj::CompareOptions optionsFromArgs(int argc, char** argv) {
  const auto args = parseArgs(argc, argv);
  csmap_proj::CompareOptions options;
  if (auto it = args.find("--csmap-dict"); it != args.end()) {
    options.csmapDict = it->second;
  }
  if (auto it = args.find("--proj-data"); it != args.end()) {
    options.projDataPath = it->second;
  }
  options.csmapSource = required(args, "--csmap-source");
  options.csmapTarget = required(args, "--csmap-target");
  options.projSource = required(args, "--proj-source");
  options.projTarget = required(args, "--proj-target");
  options.x = std::stod(required(args, "--x"));
  options.y = std::stod(required(args, "--y"));
  return options;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    bool ok = false;
    std::cout << csmap_proj::compareToJson(optionsFromArgs(argc, argv), &ok) << "\n";
    return ok ? EXIT_SUCCESS : EXIT_FAILURE;
  } catch (const std::exception& error) {
    std::cout << csmap_proj::fatalJson(error.what()) << "\n";
    return EXIT_FAILURE;
  }
}
