#pragma once

#include <string>

namespace csmap_proj {

struct CompareOptions {
  std::string csmapDict = "vendor/csmap/CsMapDev/Dictionaries";
  std::string projDataPath;
  std::string csmapSource;
  std::string csmapTarget;
  std::string projSource;
  std::string projTarget;
  double x = 0.0;
  double y = 0.0;
};

std::string compareToJson(const CompareOptions& options, bool* ok = nullptr);
std::string fatalJson(const std::string& message);

}  // namespace csmap_proj
